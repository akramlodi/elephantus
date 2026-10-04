"""REST API: a thin FastAPI layer over the memory engine.

Web UI: http://127.0.0.1:8000/  ·  interactive docs: http://127.0.0.1:8000/docs
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .config import ConfigError, load_settings
from .engine import MemoryEngine
from .llm import LLMError
from .sample_data import SAMPLE_MESSAGES

WEB_DIR = Path(__file__).with_name("web")

settings = load_settings()
app = FastAPI(
    title="Elephantus",
    version=__version__,
    description="Elephantus: a small, local memory layer for AI apps.",
)


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.middleware("http")
async def revalidate_ui(request: Request, call_next):
    """Make the browser revalidate the UI files so index.html and app.js never come from different versions."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/", include_in_schema=False)
def web_ui() -> FileResponse:
    """The terminal-style demo UI (a static page that calls this API)."""
    return FileResponse(WEB_DIR / "index.html")


@lru_cache(maxsize=1)
def get_engine() -> MemoryEngine:
    return MemoryEngine(settings)


@app.exception_handler(ValueError)
async def _value_error(_: Request, exc: ValueError):
    return JSONResponse(status_code=422, content={"detail": str(exc)})


@app.exception_handler(ConfigError)
async def _config_error(_: Request, exc: ConfigError):
    return JSONResponse(status_code=503, content={"detail": f"Configuration error: {exc}"})


@app.exception_handler(LLMError)
async def _llm_error(_: Request, exc: LLMError):
    return JSONResponse(status_code=502, content={"detail": f"LLM error: {exc}"})


# ----------------------------------------------------------------- schemas
class AddRequest(BaseModel):
    content: str = Field(..., examples=["I love Adidas sneakers"])
    container_tag: str = Field(..., examples=["khan"])
    metadata: dict = Field(default_factory=dict)
    time_offset_hours: float = Field(0.0, description="Pretend the content arrives this many hours from now.")
    extract: bool = Field(True, description="Extract and link memories (needs the LLM).")


TimeOffset = Field(0.0, description="Simulated time: pretend it is this many hours from now (expiry demos).")


class SearchRequest(BaseModel):
    q: str = Field(..., examples=["What sneakers should I buy?"])
    container_tag: str = Field(..., examples=["khan"])
    mode: Literal["memories", "documents", "hybrid"] = "memories"
    limit: int = Field(5, ge=1, le=50)
    time_offset_hours: float = TimeOffset


class ProfileRequest(BaseModel):
    container_tag: str = Field(..., examples=["khan"])
    q: str | None = Field(None, examples=["What sneakers should I buy?"])
    limit: int = Field(5, ge=1, le=50)
    time_offset_hours: float = TimeOffset


class ForgetRequest(BaseModel):
    container_tag: str = Field(..., examples=["khan"])
    memory_id: str | None = None
    content: str | None = Field(None, description="Forget the memory that best matches this text.")


class ChatRequest(BaseModel):
    question: str = Field(..., examples=["What sneakers should I buy?"])
    container_tag: str = Field(..., examples=["khan"])
    limit: int = Field(3, ge=1, le=20, description="Context items retrieved for each mode.")
    time_offset_hours: float = TimeOffset
    remember: bool = Field(False, description="Also ingest the question as new content afterwards.")


# --------------------------------------------------------------- endpoints
@app.get("/health", tags=["meta"])
def health() -> dict:
    return {
        "status": "ok",
        "version": __version__,
        "llm_provider": settings.llm_provider,
        "llm_model": settings.model,
        "embedding_backend": settings.embedding_backend,
    }


@app.post("/v1/add", tags=["memory"])
def add(req: AddRequest) -> dict:
    """Store content under a container tag; extract facts and link them to existing memories."""
    return get_engine().add(req.content, req.container_tag, req.metadata, req.time_offset_hours, req.extract)


@app.post("/v1/search", tags=["memory"])
def search(req: SearchRequest) -> dict:
    """Search memories (hybrid, current only), documents (naive RAG baseline) or both."""
    results = get_engine().search(req.q, req.container_tag, req.mode, req.limit, req.time_offset_hours)
    return {"mode": req.mode, "results": results}


@app.post("/v1/profile", tags=["memory"])
def profile(req: ProfileRequest) -> dict:
    """Static facts + recent dynamic facts (+ search results when `q` is given)."""
    return get_engine().profile(req.container_tag, req.q, req.limit, req.time_offset_hours)


@app.post("/v1/chat", tags=["chat"])
def chat(req: ChatRequest) -> dict:
    """Answer twice — naive RAG context vs. memory context — and return both with their context."""
    return get_engine().chat(req.question, req.container_tag, req.limit, req.time_offset_hours, req.remember)


@app.post("/v1/forget", tags=["memory"])
def forget(req: ForgetRequest) -> dict:
    """Forget a memory by id, or the memory that best matches `content`."""
    forgotten = get_engine().forget(req.container_tag, req.memory_id, req.content)
    if forgotten is None:
        raise HTTPException(404, "No matching current memory found.")
    return {"forgotten": forgotten}


@app.get("/v1/containers/{container_tag}/memories", tags=["inspect"])
def list_memories(container_tag: str, include_outdated: bool = True, time_offset_hours: float = 0.0) -> list[dict]:
    """All memories with their status: current / outdated / expired / forgotten."""
    return get_engine().list_memories(container_tag, include_outdated, time_offset_hours)


@app.get("/v1/containers/{container_tag}/graph", tags=["inspect"])
def graph(container_tag: str, time_offset_hours: float = 0.0) -> dict:
    """Memory nodes and UPDATES / EXTENDS edges."""
    return get_engine().graph(container_tag, time_offset_hours)


@app.get("/v1/containers/{container_tag}/context", tags=["memory"])
def context(container_tag: str, time_offset_hours: float = 0.0) -> dict:
    """The full profile as a ready-to-inject prompt block (what the MCP `context` tool returns)."""
    return {"container_tag": container_tag, "context": get_engine().context_prompt(container_tag, time_offset_hours)}


@app.get("/v1/sample-data", tags=["meta"])
def sample_data() -> list[str]:
    """The demo conversation used by the UI's "Load sample" button."""
    return SAMPLE_MESSAGES


@app.get("/v1/eval/results", tags=["meta"])
def eval_results() -> list[dict]:
    """Saved evaluation results (newest first), as written by `elephantus eval`."""
    from .evaluation import load_results

    return load_results()


@app.get("/v1/containers/{container_tag}/log", tags=["inspect"])
def link_log(container_tag: str, limit: int = 100) -> list[dict]:
    """Recent linking decisions (NEW / UPDATES / EXTENDS / DUPLICATE / FORGET)."""
    return get_engine().link_log(container_tag, limit)


@app.get("/v1/containers/{container_tag}/documents", tags=["inspect"])
def list_documents(container_tag: str) -> list[dict]:
    return get_engine().list_documents(container_tag)


@app.get("/v1/containers", tags=["inspect"])
def list_containers() -> list[str]:
    return get_engine().list_containers()


@app.delete("/v1/containers/{container_tag}", tags=["inspect"])
def reset_container(container_tag: str) -> dict:
    get_engine().reset_container(container_tag)
    return {"status": "deleted", "container_tag": container_tag}
