import os
import gzip
import json
import re
import threading
import time
from collections import deque
from datetime import datetime, timezone
from decimal import Decimal
from email.utils import parsedate_to_datetime
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from kalibre import azimuth_deg, downrange_to_local_en, haversine_distance_m
from motor import motor_from_avg
from roket import Rocket
from sim import SimConfig, simulate_2d


load_dotenv()

MET_NORWAY_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact"
MET_NORWAY_USER_AGENT = os.getenv(
    "MET_NORWAY_USER_AGENT",
    "BAYHES-Risk/1.0 (https://avionixoperasyon.vercel.app)",
)
_met_norway_cache: dict[str, dict] = {}
_met_norway_cache_lock = threading.Lock()
_met_norway_request_times: deque[float] = deque()
_met_norway_rate_lock = threading.Lock()


def _reserve_met_norway_request() -> None:
    now = time.monotonic()
    with _met_norway_rate_lock:
        while _met_norway_request_times and now - _met_norway_request_times[0] >= 1:
            _met_norway_request_times.popleft()
        if len(_met_norway_request_times) >= 19:
            raise HTTPException(status_code=429, detail="MET Norway için kısa süreli istek sınırı aşıldı; biraz sonra tekrar deneyin.")
        _met_norway_request_times.append(now)


def _cache_expiry(headers, now: float) -> float:
    cache_control = headers.get("Cache-Control", "")
    if re.search(r"(?:^|,)\s*(?:no-cache|no-store)\b", cache_control, re.IGNORECASE):
        return now
    candidates = []
    max_age = re.search(r"(?:^|,)\s*max-age=(\d+)", cache_control, re.IGNORECASE)
    if max_age:
        age = int(headers.get("Age", "0") or 0)
        candidates.append(now + max(0, int(max_age.group(1)) - age))
    expires = headers.get("Expires")
    if expires:
        try:
            candidates.append(parsedate_to_datetime(expires).astimezone(timezone.utc).timestamp())
        except (TypeError, ValueError, OverflowError):
            pass
    return min(candidates, default=now)


def fetch_met_norway(latitude: Decimal, longitude: Decimal) -> dict:
    """Fetch and cache the official forecast response according to its HTTP cache headers."""
    coordinates = f"{latitude:.4f},{longitude:.4f}"
    now = time.time()
    with _met_norway_cache_lock:
        cached = _met_norway_cache.get(coordinates)
        if cached and cached["expires_at"] > now:
            return {"provider": "MET Norway", "retrievedAt": cached["retrieved_at"], "forecast": cached["payload"]}

    _reserve_met_norway_request()
    query = urlencode({"lat": f"{latitude:.4f}", "lon": f"{longitude:.4f}"})
    headers = {
        "User-Agent": MET_NORWAY_USER_AGENT,
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
    }
    if cached and cached.get("last_modified"):
        headers["If-Modified-Since"] = cached["last_modified"]
    request = Request(f"{MET_NORWAY_URL}?{query}", headers=headers)

    try:
        with urlopen(request, timeout=12) as upstream:
            raw_body = upstream.read()
            if upstream.headers.get("Content-Encoding", "").lower() == "gzip":
                raw_body = gzip.decompress(raw_body)
            payload = json.loads(raw_body)
            expires_at = _cache_expiry(upstream.headers, time.time())
            last_modified = upstream.headers.get("Last-Modified")
            retrieved_at = datetime.now(timezone.utc).isoformat()
    except HTTPError as exc:
        if exc.code == 304 and cached:
            expires_at = _cache_expiry(exc.headers, time.time())
            with _met_norway_cache_lock:
                cached["expires_at"] = expires_at
                cached["retrieved_at"] = datetime.now(timezone.utc).isoformat()
            return {"provider": "MET Norway", "retrievedAt": cached["retrieved_at"], "forecast": cached["payload"]}
        if exc.code == 429:
            raise HTTPException(status_code=503, detail="MET Norway istek sınırı geçici olarak aşıldı.") from exc
        raise HTTPException(status_code=502, detail=f"MET Norway servisi HTTP {exc.code} yanıtı verdi.") from exc
    except (TimeoutError, URLError) as exc:
        if isinstance(exc, URLError) and isinstance(exc.reason, TimeoutError):
            raise HTTPException(status_code=504, detail="MET Norway isteği zaman aşımına uğradı.") from exc
        raise HTTPException(status_code=502, detail="MET Norway servisine bağlanılamadı.") from exc
    except (json.JSONDecodeError, UnicodeDecodeError, gzip.BadGzipFile) as exc:
        raise HTTPException(status_code=502, detail="MET Norway geçerli JSON yanıtı döndürmedi.") from exc
    except OSError as exc:
        raise HTTPException(status_code=502, detail="MET Norway yanıtı okunamadı.") from exc

    if not isinstance(payload, dict) or not isinstance(payload.get("properties", {}).get("timeseries"), list):
        raise HTTPException(status_code=502, detail="MET Norway yanıt şeması beklenen tahmin verisini içermiyor.")

    with _met_norway_cache_lock:
        _met_norway_cache[coordinates] = {
            "payload": payload,
            "retrieved_at": retrieved_at,
            "expires_at": expires_at,
            "last_modified": last_modified,
        }
    return {"provider": "MET Norway", "retrievedAt": retrieved_at, "forecast": payload}


class BayhesRequest(BaseModel):
    launch_lat: float = Field(..., ge=-90, le=90)
    launch_lon: float = Field(..., ge=-180, le=180)
    target_lat: float = Field(..., ge=-90, le=90)
    target_lon: float = Field(..., ge=-180, le=180)
    elevation_deg: float = Field(..., gt=0, lt=90)
    dry_mass: float = Field(..., gt=0)
    prop_mass: float = Field(..., ge=0)
    diameter_m: float = Field(..., gt=0)
    cd: float = Field(..., gt=0)
    thrust_avg: float = Field(..., gt=0)
    burn_s: float = Field(..., gt=0)
    wind: float = Field(0.0)


class BayhesResponse(BaseModel):
    distance_m: float
    azimuth_deg: float
    flight_time_s: float
    max_alt_m: float
    impact_downrange_m: float
    impact_E: float
    impact_N: float
    max_speed_mps: float
    status: Literal["success"]


app = FastAPI(
    title="Mühendislik Hesaplama ve Simülasyon Platformu API",
    version="1.0.0",
)

local_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
env_origins = [
    os.getenv("FRONTEND_ORIGIN", ""),
    *os.getenv("ALLOWED_ORIGINS", "").split(","),
]
allowed_origins = local_origins + [
    origin.strip()
    for origin in env_origins
    if origin and origin.strip() and origin.strip() not in local_origins
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "message": "Backend çalışıyor"}


@app.get("/api/weather/met-norway")
def met_norway_weather(
    latitude: Decimal = Query(..., alias="lat", ge=Decimal("-90"), le=Decimal("90")),
    longitude: Decimal = Query(..., alias="lon", ge=Decimal("-180"), le=Decimal("180")),
) -> dict:
    if max(0, -latitude.as_tuple().exponent) > 4 or max(0, -longitude.as_tuple().exponent) > 4:
        raise HTTPException(status_code=422, detail="MET Norway isteklerinde koordinatlar en fazla 4 ondalık basamak içerebilir.")
    return fetch_met_norway(latitude, longitude)


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> Response:
    return Response(status_code=204)


@app.post("/api/bayhes/simulate", response_model=BayhesResponse)
def simulate_bayhes(payload: BayhesRequest) -> BayhesResponse:
    try:
        distance = haversine_distance_m(
            payload.launch_lat,
            payload.launch_lon,
            payload.target_lat,
            payload.target_lon,
        )
        azimuth = azimuth_deg(
            payload.launch_lat,
            payload.launch_lon,
            payload.target_lat,
            payload.target_lon,
        )

        motor = motor_from_avg(payload.thrust_avg, payload.burn_s)
        rocket = Rocket(
            dry_mass=payload.dry_mass,
            prop_mass=payload.prop_mass,
            diameter_m=payload.diameter_m,
            cd=payload.cd,
            motor=motor,
        )
        config = SimConfig(elevation_deg=payload.elevation_deg, wind=payload.wind)
        result = simulate_2d(rocket, config)
        impact_e, impact_n = downrange_to_local_en(result["impact_downrange_m"], azimuth)

        return BayhesResponse(
            distance_m=distance,
            azimuth_deg=azimuth,
            flight_time_s=result["flight_time_s"],
            max_alt_m=result["max_alt_m"],
            impact_downrange_m=result["impact_downrange_m"],
            impact_E=impact_e,
            impact_N=impact_n,
            max_speed_mps=result["max_speed_mps"],
            status="success",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail={"status": "error", "message": str(exc)},
        ) from exc
