const test = require("node:test");
const assert = require("node:assert/strict");
const weather = require("./weatherProviders.js");

test("locale coordinates accept comma and dot without changing values", () => {
  assert.equal(weather.parseCoordinate("36,6439", "Enlem", -90, 90), 36.6439);
  assert.equal(weather.parseCoordinate("36.6439", "Enlem", -90, 90), 36.6439);
  assert.equal(weather.parseCoordinate("33,4384", "Boylam", -180, 180), 33.4384);
  assert.equal(weather.parseCoordinate("33.4384", "Boylam", -180, 180), 33.4384);
  assert.throws(() => weather.parseCoordinate("36,6.4", "Enlem", -90, 90), { code: "INVALID_COORDINATE" });
  assert.throws(() => weather.parseCoordinate("90,1", "Enlem", -90, 90), { code: "COORDINATE_OUT_OF_RANGE" });
});

test("provider selection is explicit and MGM stays unconfigured", async () => {
  assert.equal(weather.getProvider("open-meteo").name, "Open-Meteo");
  assert.equal(weather.getProvider("open-meteo").configured, true);
  assert.equal(weather.getProvider("met-norway").configured, true);
  assert.equal(weather.getProvider("met-norway").name, "MET Norway — tahmin");
  assert.equal(weather.getProvider("mgm").configured, false);
  await assert.rejects(weather.getProvider("mgm").fetchSnapshot(), { code: "PROVIDER_NOT_CONFIGURED" });
  assert.throws(() => weather.getProvider("other"), { code: "UNKNOWN_PROVIDER" });
});

test("MET Norway coordinates are truncated to four decimals in the request only", () => {
  const url = new URL(weather.metNorwayRequestUrl("36,64399", "33.43849", "http://127.0.0.1:8000/api/weather/met-norway"));
  assert.equal(url.searchParams.get("lat"), "36.6439");
  assert.equal(url.searchParams.get("lon"), "33.4384");
});

test("MET Norway selection reports failures without using another provider", async () => {
  const urls = [];
  await assert.rejects(weather.getProvider("met-norway").fetchSnapshot({
    latitude: 36.6439,
    longitude: 33.4384,
    endpoint: "https://backend.example/api/weather/met-norway",
    fetchImpl: async (url) => {
      urls.push(url);
      throw new Error("offline");
    },
  }), { code: "NETWORK_ERROR" });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/backend\.example\/api\/weather\/met-norway\?/);
});

test("MGM does not make a network request or fall back to Open-Meteo while unconfigured", async () => {
  let networkRequests = 0;
  const fetchImpl = async () => {
    networkRequests += 1;
    throw new Error("MGM için ağ isteği beklenmiyordu");
  };

  await assert.rejects(
    weather.getProvider("mgm").fetchSnapshot({ latitude: 36, longitude: 33, fetchImpl }),
    { code: "PROVIDER_NOT_CONFIGURED" },
  );
  assert.equal(networkRequests, 0);
});

test("shared model represents unavailable fields as unknown and rejects incomplete data", () => {
  const snapshot = weather.createSnapshot({ source: "MGM" });
  assert.equal(snapshot.stationCode, null);
  assert.equal(snapshot.temperatureC, null);
  assert.equal(snapshot.windGustMs, null);
  assert.throws(() => weather.validateSnapshot(snapshot), { code: "MISSING_FIELDS" });
});

test("Open-Meteo response maps documented units into the shared model", async () => {
  const now = new Date();
  const apiTime = now.toISOString().slice(0, 16);
  let requestedUrl;
  const snapshot = await weather.fetchOpenMeteoSnapshot({
    latitude: "36,6439",
    longitude: "33.4384",
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return {
        ok: true,
        json: async () => ({
          current: {
            temperature_2m: 21.5,
            relative_humidity_2m: 48,
            pressure_msl: 1008.2,
            wind_speed_10m: 4.3,
            wind_direction_10m: 180,
            wind_gusts_10m: 6.1,
            time: apiTime,
          },
        }),
      };
    },
  });

  assert.equal(requestedUrl.searchParams.get("latitude"), "36.6439");
  assert.equal(requestedUrl.searchParams.get("temperature_unit"), "celsius");
  assert.equal(requestedUrl.searchParams.get("wind_speed_unit"), "ms");
  assert.equal(snapshot.temperatureC, 21.5);
  assert.equal(snapshot.pressureHpa, 1008.2);
  assert.equal(snapshot.windSpeedMs, 4.3);
  assert.equal(snapshot.timeKind, "model");
  assert.equal(snapshot.stationCode, null);
  assert.equal(snapshot.source, "Open-Meteo");
  assert.equal(snapshot.freshness, "fresh");
});

test("MET Norway forecast maps only documented fields and keeps model, forecast, and retrieval times distinct", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const payload = {
    provider: "MET Norway",
    retrievedAt: "2026-10-15T12:01:00Z",
    forecast: {
      properties: {
        meta: { updated_at: "2026-10-15T06:00:00Z", units: {
          air_temperature: "celsius", relative_humidity: "%", air_pressure_at_sea_level: "hPa",
          wind_speed: "m/s", wind_from_direction: "degrees",
        } },
        timeseries: [{
          time: "2026-10-15T12:00:00Z",
          data: { instant: { details: {
            air_temperature: 18.4,
            relative_humidity: 62,
            air_pressure_at_sea_level: 1007.5,
            wind_speed: 3.2,
            wind_from_direction: 245,
            // No gust field: the integration must not synthesize one.
          } } },
        }],
      },
    },
  };
  const snapshot = weather.parseMetNorwaySnapshot(payload, { now, retrievedAt: "2026-10-15T12:01:00Z" });
  assert.equal(snapshot.temperatureC, 18.4);
  assert.equal(snapshot.humidityPercent, 62);
  assert.equal(snapshot.pressureHpa, 1007.5);
  assert.equal(snapshot.windSpeedMs, 3.2);
  assert.equal(snapshot.windDirectionDeg, 245);
  assert.equal(snapshot.windGustMs, null);
  assert.equal(snapshot.stationCode, null);
  assert.equal(snapshot.source, "MET Norway — tahmin");
  assert.equal(snapshot.validAt, "2026-10-15T12:00:00.000Z");
  assert.equal(snapshot.modelUpdatedAt, "2026-10-15T06:00:00.000Z");
  assert.equal(snapshot.retrievedAt, "2026-10-15T12:01:00.000Z");
  assert.equal(snapshot.timeKind, "forecast");
});

test("MET Norway missing, invalid, malformed, and stale forecasts fail visibly", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const makePayload = (details, updatedAt = "2026-10-15T06:00:00Z") => ({
    properties: {
      meta: { updated_at: updatedAt, units: {
        air_temperature: "celsius", relative_humidity: "%", air_pressure_at_sea_level: "hPa",
        wind_speed: "m/s", wind_from_direction: "degrees",
      } },
      timeseries: [{ time: "2026-10-15T12:00:00Z", data: { instant: { details } } }],
    },
  });
  const complete = {
    air_temperature: 18,
    relative_humidity: 60,
    air_pressure_at_sea_level: 1008,
    wind_speed: 4,
    wind_from_direction: 200,
  };
  assert.throws(() => weather.parseMetNorwaySnapshot({ properties: { timeseries: [] } }, { now }), { code: "INVALID_RESPONSE" });
  assert.throws(() => weather.parseMetNorwaySnapshot(makePayload({ ...complete, relative_humidity: undefined }), { now }), { code: "MISSING_FIELDS" });
  assert.throws(() => weather.parseMetNorwaySnapshot(makePayload({ ...complete, wind_speed: -1 }), { now }), { code: "INVALID_FIELD" });
  const invalidUnits = makePayload(complete);
  invalidUnits.properties.meta.units.wind_speed = "km/h";
  assert.throws(() => weather.parseMetNorwaySnapshot(invalidUnits, { now }), { code: "INVALID_RESPONSE" });
  assert.throws(() => weather.parseMetNorwaySnapshot(makePayload(complete, "2026-10-14T23:59:00Z"), { now }), { code: "STALE_DATA" });
});

test("missing and invalid weather fields are rejected", async () => {
  await assert.rejects(weather.fetchOpenMeteoSnapshot({
    latitude: 36,
    longitude: 33,
    fetchImpl: async () => ({ ok: true, json: async () => ({ current: { temperature_2m: 20, time: new Date().toISOString() } }) }),
  }), { code: "MISSING_FIELDS" });

  assert.throws(() => weather.createSnapshot({ temperatureC: 90 }), { code: "INVALID_FIELD" });
  assert.throws(() => weather.createSnapshot({ humidityPercent: -1 }), { code: "INVALID_FIELD" });
});

test("stale response, network failure, timeout, HTTP error, and invalid JSON are reported", async () => {
  const oldSnapshot = weather.createSnapshot({
    temperatureC: 20,
    humidityPercent: 50,
    pressureHpa: 1010,
    windSpeedMs: 3,
    windDirectionDeg: 90,
    validAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    source: "Open-Meteo",
  });
  assert.throws(() => weather.validateSnapshot(oldSnapshot), { code: "STALE_DATA" });

  await assert.rejects(weather.requestJson("https://example.invalid", {
    fetchImpl: async () => { throw new Error("offline"); },
  }), { code: "NETWORK_ERROR" });

  await assert.rejects(weather.requestJson("https://example.invalid", {
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  }), { code: "TIMEOUT" });

  await assert.rejects(weather.requestJson("https://example.invalid", {
    fetchImpl: async () => ({ ok: false, status: 503 }),
  }), { code: "HTTP_ERROR" });

  await assert.rejects(weather.requestJson("https://example.invalid", {
    fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }),
  }), { code: "INVALID_RESPONSE" });
});
