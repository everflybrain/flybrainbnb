"""
HTTP + SSE API for the brain (DESIGN.md 6).

  uvicorn server:app --host 0.0.0.0 --port $PORT      (or: py server.py)

Env: CORS_ORIGINS (comma list of allowed site origins; none = no cross-origin access),
plus everything engine.Config reads. The sim starts on app startup unless BRAIN_AUTOSTART=0.
"""
import asyncio
import gzip
import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

KEEPALIVE_S = 15.0


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


def origins(env=None):
    e = os.environ if env is None else env
    return [o.strip().rstrip("/") for o in (e.get("CORS_ORIGINS") or "").split(",") if o.strip()]


def create_app(engine_factory, autostart=True, env=None):
    state = {}

    @asynccontextmanager
    async def lifespan(app):
        eng = engine_factory()
        state["engine"] = eng
        state["loop"] = asyncio.get_running_loop()
        state["clients"] = set()

        def push(event, data):
            loop = state["loop"]
            def put(q, item):
                if not q.full():          # a slow client drops events rather than stalling
                    q.put_nowait(item)
            for q in list(state["clients"]):
                loop.call_soon_threadsafe(put, q, (event, data))
        eng.listeners.append(push)
        if autostart:
            eng.start()
        yield

    app = FastAPI(title="flybrainbnb brain", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(CORSMiddleware, allow_origins=origins(env), allow_methods=["GET"],
                       allow_headers=["*"], allow_credentials=False)

    def eng():
        return state["engine"]

    @app.get("/status")
    def status():
        return eng().status()

    @app.get("/neurons.bin")
    def neurons_bin():
        return FileResponse(eng().neurons_bin, media_type="application/octet-stream",
                            headers={"Cache-Control": "public, max-age=86400"})

    @app.get("/frame")
    def frame():
        f = eng().latest
        if f is None:
            raise HTTPException(503, "no frame yet")
        return {k: v for k, v in f.items() if not k.startswith("_")}

    @app.get("/frame.bin")
    def frame_bin(request: Request, w: int | None = None):
        win, dense = eng().frame_bin(w)
        if dense is None:
            raise HTTPException(404, "window not in the last 30")
        headers = {"X-Window": str(win), "Cache-Control": "public, max-age=3600"}
        if "gzip" in request.headers.get("accept-encoding", ""):
            # compress once here (level 6) so GZipMiddleware leaves it alone
            return Response(gzip.compress(dense, 6), media_type="application/octet-stream",
                            headers={**headers, "Content-Encoding": "gzip", "Vary": "Accept-Encoding"})
        return Response(dense, media_type="application/octet-stream", headers=headers)

    @app.get("/channels")
    def channels():
        e = eng()
        return {**e.channels, "superclasses": e.superclasses, "gating": e.channels["gating"],
                "stats": e.gates.stats()}

    @app.get("/owners")
    def owners(offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
        return eng().registry.page(offset, limit)

    @app.get("/neuron/{nid}")
    def neuron(nid: int):
        e = eng()
        if not 0 <= nid < e.n:
            raise HTTPException(404, "no such neuron")
        return e.neuron(nid)

    @app.get("/epoch/{e}")
    def epoch(e: int):
        rec = eng().epoch_record(e)
        if rec is None:
            raise HTTPException(404, "epoch not recorded")
        return rec

    @app.get("/stream")
    async def stream(request: Request, once: int = 0):
        e = eng()
        q = asyncio.Queue(maxsize=100)

        async def gen():
            if e.latest is not None:
                yield sse("frame", {k: v for k, v in e.latest.items() if k != "top" and not k.startswith("_")})
            if once:
                return
            state["clients"].add(q)
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        event, data = await asyncio.wait_for(q.get(), KEEPALIVE_S)
                        yield sse(event, data)
                    except asyncio.TimeoutError:
                        yield ": keep-alive\n\n"
            finally:
                state["clients"].discard(q)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.exception_handler(ValueError)
    def bad(_req, exc):
        return JSONResponse({"detail": "bad request"}, status_code=400)

    return app


def _default_engine():
    from engine import Config, Engine
    return Engine(Config())


app = create_app(_default_engine, autostart=os.environ.get("BRAIN_AUTOSTART", "1") != "0")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), log_level="warning")
