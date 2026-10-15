(function initializeBayhesWeatherProviders(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BayhesWeatherProviders = api;
})(typeof globalThis === "undefined" ? this : globalThis, function createBayhesWeatherProviders() {
  const OPEN_METEO_MAX_AGE_MS = 3 * 60 * 60 * 1000;
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
    getProvider,
    openMeteoRequestUrl,
    parseCoordinate,
    parseLocalizedNumber,
    requestJson,
    validateSnapshot,
  });
});
