"""The web UI: static files, its API endpoints, and (optionally) a real-browser run."""

import os
import threading
import time

import pytest
from fastapi.testclient import TestClient

from elephantus import api
from tests.test_linking import ADIDAS, BROKE, PUMA, sneaker_llm  # noqa: F401


@pytest.fixture
def client(engine, monkeypatch):
    monkeypatch.setattr(api, "get_engine", lambda: engine)
    return TestClient(api.app)


def test_index_and_static_assets(client):
    r = client.get("/")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert "/static/app.js" in r.text and "/static/app.css" in r.text
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/static/app.css").status_code == 200


def test_ui_support_endpoints(client, engine, sneaker_llm, tmp_path, monkeypatch):  # noqa: F811
    from elephantus import evaluation
    from elephantus.sample_data import SAMPLE_MESSAGES

    assert client.get("/v1/sample-data").json() == SAMPLE_MESSAGES
    for msg in ["I love Adidas sneakers", "I'm switching to Puma"]:
        engine.add(msg, "khan")
    ctx = client.get("/v1/containers/khan/context").json()["context"]
    assert PUMA in ctx and ADIDAS not in ctx

    monkeypatch.setattr(evaluation, "RESULTS_DIR", tmp_path)
    assert client.get("/v1/eval/results").json() == []
    (tmp_path / "x.json").write_text('{"label": "x", "created_at": "2026"}')
    assert client.get("/v1/eval/results").json()[0]["label"] == "x"


# ---------------------------------------------------------------- browser e2e
def _chromium():
    pw = pytest.importorskip("playwright.sync_api")
    exe = os.getenv("PLAYWRIGHT_CHROMIUM") or ("/opt/pw-browsers/chromium" if os.path.exists("/opt/pw-browsers/chromium") else None)
    return pw, exe


def test_browser_sneaker_flow(engine, sneaker_llm, monkeypatch):  # noqa: F811
    pw, exe = _chromium()
    import uvicorn

    sneaker_llm.answer = lambda system, prompt: "Adidas, of course." if "Relevant past messages" in system else "Go with Puma."
    monkeypatch.setattr(api, "get_engine", lambda: engine)
    server = uvicorn.Server(uvicorn.Config(api.app, host="127.0.0.1", port=8765, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.05)
    errors = []
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
            page = browser.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto("http://127.0.0.1:8765/")
            for i, msg in enumerate(["I love Adidas sneakers", "My Adidas broke after a month",
                                     "I'm switching to Puma", "What sneakers should I buy?"], start=1):
                page.fill("#chat-input", msg)
                page.press("#chat-input", "Enter")
                page.wait_for_function(f"document.querySelectorAll('#transcript .turn .answers').length >= {i}")
            assert page.locator("#n-outdated").inner_text() == "1"
            assert "UPDATES" in page.locator("#transcript").inner_text()
            assert "Go with Puma." in page.locator(".box.mem").last.inner_text()
            assert "Adidas, of course." in page.locator(".box.rag").last.inner_text()

            page.click("[data-tab=memories]")
            page.wait_for_selector("#memory-list .row.outdated")
            assert ADIDAS in page.locator("#memory-list .row.outdated").inner_text()
            page.click("[data-tab=graph]")
            page.wait_for_selector("#graph-view svg")
            assert "UPDATES" in page.locator("#graph-view svg").inner_html()
            assert page.evaluate("window.scrollY") == 0  # switching tabs must not scroll the page
            page.click("[data-tab=profile]")
            page.wait_for_function("document.querySelector('#profile-prompt').textContent.length > 0")
            assert PUMA in page.locator("#profile-dynamic").inner_text()
            page.click("[data-tab=search]")
            page.fill("#search-input", "sneakers")
            page.press("#search-input", "Enter")
            page.wait_for_selector("#search-results .row")
            for tab in ("eval", "log"):
                page.click(f"[data-tab={tab}]")
            page.wait_for_selector("#log-list .row")
            page.goto("http://127.0.0.1:8765/#graph")  # same page, new hash -> switches tab
            page.wait_for_selector("#graph-view svg")
            assert page.evaluate("window.scrollY") == 0
            page.reload()  # opening the page on #graph must not scroll either
            page.wait_for_selector("#graph-view svg")
            assert page.evaluate("window.scrollY") == 0
            browser.close()
    finally:
        server.should_exit = True
        thread.join(timeout=5)
    assert not errors, errors
    assert BROKE in [m["text"] for m in engine.list_memories("khan")]
