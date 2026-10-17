(function initializeBayhesWeatherProviders(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BayhesWeatherProviders = api;
})(typeof globalThis === "undefined" ? this : globalThis, function createBayhesWeatherProviders() {
  const OPEN_METEO_MAX_AGE_MS = 3 * 60 * 60 * 1000;
  const MET_NORWAY_MAX_MODEL_AGE_MS = 12 * 60 * 60 * 1000;
  const REQUIRED_FIELDS = [
    "temperatureC",
    "humidityPercent",
    "pressureHpa",
    "windSpeedMs",
    "windDirectionDeg",
  ];
  const FIELD_LABELS = {
    temperatureC: "sıcaklık",
    humidityPercent: "bağıl nem",
    pressureHpa: "basınç",
    windSpeedMs: "rüzgâr hızı",
    windDirectionDeg: "rüzgâr yönü",
  };
  const MET_NORWAY_UNITS = {
    air_temperature: "celsius",
    relative_humidity: "%",
    air_pressure_at_sea_level: "hPa",
    wind_speed: "m/s",
    wind_from_direction: "degrees",
  };

  class WeatherDataError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "WeatherDataError";
      this.code = code;
    }
  }

  function parseLocalizedNumber(value) {
    const raw = String(value ?? "").trim();
    if (raw === "") return null;
    if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
      return Number.NaN;
    }
    const parsed = Number(raw.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }

  function parseCoordinate(value, label, min, max) {
    const parsed = parseLocalizedNumber(value);
    if (parsed === null || !Number.isFinite(parsed)) {
      throw new WeatherDataError("INVALID_COORDINATE", `${label} sayısal olmalıdır.`);
    }
    if (parsed < min || parsed > max) {
      throw new WeatherDataError("COORDINATE_OUT_OF_RANGE", `${label} ${min} ile ${max} arasında olmalıdır.`);
    }
    return parsed;
  }

  function truncateCoordinateForMetNorway(value) {
    return Math.trunc(value * 10000) / 10000;
  }

  function optionalNumber(value, field, min, max) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      throw new WeatherDataError("INVALID_FIELD", `${FIELD_LABELS[field] || field} değeri geçersiz.`);
    }
    return parsed;
  }

  function parseTimestamp(value) {
    if (!value) return null;
    const raw = String(value).trim();
    const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(raw)
      ? `${raw}Z`
      : raw;
    const parsed = new Date(normalized);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  function createSnapshot(raw = {}) {
    const validAt = parseTimestamp(raw.validAt);
    return {
      temperatureC: optionalNumber(raw.temperatureC, "temperatureC", -100, 70),
      humidityPercent: optionalNumber(raw.humidityPercent, "humidityPercent", 0, 100),
      pressureHpa: optionalNumber(raw.pressureHpa, "pressureHpa", 300, 1200),
      windSpeedMs: optionalNumber(raw.windSpeedMs, "windSpeedMs", 0, 150),
      windDirectionDeg: optionalNumber(raw.windDirectionDeg, "windDirectionDeg", 0, 360),
      windGustMs: optionalNumber(raw.windGustMs, "windGustMs", 0, 200),
      validAt,
      modelUpdatedAt: parseTimestamp(raw.modelUpdatedAt),
      timeKind: ["observation", "forecast", "model"].includes(raw.timeKind) ? raw.timeKind : "unknown",
      stationCode: typeof raw.stationCode === "string" && raw.stationCode.trim() ? raw.stationCode.trim() : null,
      source: typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : "unknown",
      retrievedAt: parseTimestamp(raw.retrievedAt) || new Date().toISOString(),
      freshness: "unknown",
      missingFields: [],
    };
  }

  function validateSnapshot(snapshot, { now = Date.now(), maxAgeMs = OPEN_METEO_MAX_AGE_MS } = {}) {
    const missing = REQUIRED_FIELDS.filter((field) => snapshot[field] === null);
    if (missing.length) {
      throw new WeatherDataError(
        "MISSING_FIELDS",
        `Meteoroloji yanıtında şu alanlar yok: ${missing.map((field) => FIELD_LABELS[field]).join(", ")}.`,
      );
    }
    if (!snapshot.validAt) {
      throw new WeatherDataError("MISSING_TIMESTAMP", "Meteoroloji yanıtında geçerli ölçüm/model zamanı yok.");
    }

    const validAtMs = Date.parse(snapshot.validAt);
    const ageMs = now - validAtMs;
    if (ageMs > maxAgeMs) {
      throw new WeatherDataError("STALE_DATA", "Meteoroloji verisi izin verilen güncellik süresini aşmış.");
    }
    if (ageMs < -15 * 60 * 1000) {
      throw new WeatherDataError("FUTURE_DATA", "Meteoroloji verisinin zamanı gelecekte görünüyor.");
    }

    return { ...snapshot, freshness: "fresh", ageMs, missingFields: [] };
  }

  async function requestJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new WeatherDataError("NETWORK_UNAVAILABLE", "Tarayıcıda ağ isteği desteklenmiyor.");
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let response;
      try {
        response = await fetchImpl(url, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (timedOut) throw new WeatherDataError("TIMEOUT", "Meteoroloji isteği zaman aşımına uğradı.");
        throw new WeatherDataError("NETWORK_ERROR", "Meteoroloji servisine bağlanılamadı.");
      }

      if (!response.ok) {
        throw new WeatherDataError("HTTP_ERROR", `Meteoroloji servisi HTTP ${response.status} yanıtı verdi.`);
      }

      try {
        return await response.json();
      } catch {
        throw new WeatherDataError("INVALID_RESPONSE", "Meteoroloji servisi geçerli JSON döndürmedi.");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function openMeteoRequestUrl(latitudeValue, longitudeValue) {
    const latitude = parseCoordinate(latitudeValue, "Enlem", -90, 90);
    const longitude = parseCoordinate(longitudeValue, "Boylam", -180, 180);
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      current: "temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
      temperature_unit: "celsius",
      wind_speed_unit: "ms",
      timezone: "GMT",
      forecast_days: "1",
    });
    return `https://api.open-meteo.com/v1/forecast?${params}`;
  }

  function metNorwayRequestUrl(latitudeValue, longitudeValue, endpoint) {
    const latitude = truncateCoordinateForMetNorway(parseCoordinate(latitudeValue, "Enlem", -90, 90));
    const longitude = truncateCoordinateForMetNorway(parseCoordinate(longitudeValue, "Boylam", -180, 180));
    const params = new URLSearchParams({ lat: latitude.toFixed(4), lon: longitude.toFixed(4) });
    const configuredBase = typeof endpoint === "string" ? endpoint : "";
    const base = configuredBase || `${root?.BAYHES_API_BASE_URL || ""}/api/weather/met-norway`;
    return `${base}${base.includes("?") ? "&" : "?"}${params}`;
  }

  function closestForecastPoint(timeseries, now) {
    const current = now instanceof Date ? now.getTime() : Number(now ?? Date.now());
    const validPoints = timeseries
      .filter((item) => item && typeof item === "object" && Number.isFinite(Date.parse(item.time)))
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    if (!validPoints.length) {
      throw new WeatherDataError("INVALID_RESPONSE", "MET Norway yanıtında geçerli tahmin zamanları yok.");
    }
    return validPoints.reduce((closest, item) =>
      Math.abs(Date.parse(item.time) - current) < Math.abs(Date.parse(closest.time) - current) ? item : closest,
    validPoints[0]);
  }

  function parseMetNorwaySnapshot(payload, { now = Date.now(), retrievedAt = new Date(now).toISOString() } = {}) {
    const forecast = payload?.forecast || payload;
    const metadata = forecast?.properties?.meta;
    const units = metadata?.units;
    if (!units || Object.entries(MET_NORWAY_UNITS).some(([field, expected]) => units[field] !== expected)) {
      throw new WeatherDataError("INVALID_RESPONSE", "MET Norway parametrelerinin birimleri eksik veya beklenenden farklı.");
    }
    const point = closestForecastPoint(forecast?.properties?.timeseries || [], now);
    const details = point?.data?.instant?.details;
    if (!details || typeof details !== "object") {
      throw new WeatherDataError("INVALID_RESPONSE", "MET Norway yanıtında anlık tahmin alanı yok.");
    }
    const updatedAt = parseTimestamp(metadata?.updated_at);
    if (!updatedAt) {
      throw new WeatherDataError("MISSING_TIMESTAMP", "MET Norway yanıtında model güncelleme zamanı yok.");
    }
    const modelAge = now - Date.parse(updatedAt);
    if (modelAge > MET_NORWAY_MAX_MODEL_AGE_MS) {
      throw new WeatherDataError("STALE_DATA", "MET Norway model verisi 12 saatten eski; eski tahmin gösterilmedi.");
    }
    if (modelAge < -15 * 60 * 1000) {
      throw new WeatherDataError("INVALID_RESPONSE", "MET Norway model güncelleme zamanı gelecekte görünüyor.");
    }

    const snapshot = createSnapshot({
      temperatureC: details.air_temperature,
      humidityPercent: details.relative_humidity,
      pressureHpa: details.air_pressure_at_sea_level,
      windSpeedMs: details.wind_speed,
      windDirectionDeg: details.wind_from_direction,
      windGustMs: null,
      validAt: point.time,
      timeKind: "forecast",
      stationCode: null,
      source: "MET Norway — tahmin",
      retrievedAt: payload?.retrievedAt || retrievedAt,
      modelUpdatedAt: updatedAt,
    });
    const missing = REQUIRED_FIELDS.filter((field) => snapshot[field] === null);
    if (missing.length) {
      throw new WeatherDataError(
        "MISSING_FIELDS",
        `MET Norway tahmininde gerekli alanlar yok: ${missing.map((field) => FIELD_LABELS[field]).join(", ")}.`,
      );
    }
    const validAtMs = Date.parse(snapshot.validAt);
    const forecastOffsetMs = validAtMs - now;
    if (forecastOffsetMs > 6 * 60 * 60 * 1000 || forecastOffsetMs < -3 * 60 * 60 * 1000) {
      throw new WeatherDataError("STALE_DATA", "MET Norway yanıtındaki en yakın tahmin zamanı güncel değil.");
    }
    return { ...snapshot, freshness: "fresh", ageMs: now - Date.parse(snapshot.modelUpdatedAt), missingFields: [] };
  }

  async function fetchMetNorwaySnapshot({ latitude, longitude, fetchImpl, timeoutMs, endpoint } = {}) {
    const payload = await requestJson(metNorwayRequestUrl(latitude, longitude, endpoint), { fetchImpl, timeoutMs });
    return parseMetNorwaySnapshot(payload);
  }

  async function fetchOpenMeteoSnapshot({ latitude, longitude, fetchImpl, timeoutMs } = {}) {
    const payload = await requestJson(openMeteoRequestUrl(latitude, longitude), { fetchImpl, timeoutMs });
    const current = payload?.current;
    if (!current || typeof current !== "object") {
      throw new WeatherDataError("INVALID_RESPONSE", "Open-Meteo yanıtında güncel veri bölümü yok.");
    }

    const snapshot = createSnapshot({
      temperatureC: current.temperature_2m,
      humidityPercent: current.relative_humidity_2m,
      pressureHpa: current.pressure_msl,
      windSpeedMs: current.wind_speed_10m,
      windDirectionDeg: current.wind_direction_10m,
      windGustMs: current.wind_gusts_10m,
      validAt: current.time,
      timeKind: "model",
      stationCode: null,
      source: "Open-Meteo",
    });
    return validateSnapshot(snapshot, { maxAgeMs: 3 * 60 * 60 * 1000 });
  }

  async function fetchMgmSnapshot() {
    throw new WeatherDataError(
      "PROVIDER_NOT_CONFIGURED",
      "MGM yetkili servis/FTP adresi, erişim bilgileri ve doğrulanmış alan şeması bekleniyor.",
    );
  }

  const providers = Object.freeze({
    "open-meteo": Object.freeze({ id: "open-meteo", name: "Open-Meteo", configured: true, fetchSnapshot: fetchOpenMeteoSnapshot }),
    "met-norway": Object.freeze({ id: "met-norway", name: "MET Norway — tahmin", configured: true, fetchSnapshot: fetchMetNorwaySnapshot }),
    mgm: Object.freeze({ id: "mgm", name: "MGM", configured: false, fetchSnapshot: fetchMgmSnapshot }),
  });

  function getProvider(id) {
    const provider = providers[id];
    if (!provider) throw new WeatherDataError("UNKNOWN_PROVIDER", "Seçilen meteoroloji sağlayıcısı tanınmıyor.");
    return provider;
  }

  return Object.freeze({
    FIELD_LABELS,
    REQUIRED_FIELDS,
    WeatherDataError,
    createSnapshot,
    fetchOpenMeteoSnapshot,
    fetchMetNorwaySnapshot,
    getProvider,
    metNorwayRequestUrl,
    openMeteoRequestUrl,
    parseCoordinate,
    parseLocalizedNumber,
    parseMetNorwaySnapshot,
    requestJson,
    validateSnapshot,
  });
});
