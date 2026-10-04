const FORECAST_API_URL = "https://api.open-meteo.com/v1/forecast";
const ELEVATION_API_URL = "https://api.open-meteo.com/v1/elevation";
const GEOCODING_API_URL = "https://geocoding-api.open-meteo.com/v1/search";

export const WEATHER_DATA_TYPES = Object.freeze({
  MGM_LIVE: "mgm-live",
  OPEN_METEO: "open-meteo",
  RUNWAY_MEASUREMENT: "runway-measurement",
  MANUAL_ESTIMATE: "manual-estimate",
});

export const WEATHER_DATA_TYPE_LABELS = Object.freeze({
  [WEATHER_DATA_TYPES.MGM_LIVE]: "MGM canlı istasyon verisi",
  [WEATHER_DATA_TYPES.OPEN_METEO]: "Open-Meteo model tahmini",
  [WEATHER_DATA_TYPES.RUNWAY_MEASUREMENT]: "Pist üstü manuel ölçüm",
  [WEATHER_DATA_TYPES.MANUAL_ESTIMATE]: "Manuel tahmini giriş",
});

export const EMPTY_WEATHER = Object.freeze({
  source: "Manuel tahmini giriş",
  sourceType: WEATHER_DATA_TYPES.MANUAL_ESTIMATE,
  stationName: "",
  stationDistanceKm: null,
  temperatureC: "",
  humidityPercent: "",
  pressureHpa: "",
  windSpeedMs: "",
  windDirectionDeg: "",
  gustSpeedMs: "",
  observedAt: null,
});

export function createEmptyWeather() {
  return { ...EMPTY_WEATHER };
}

export function getWeatherDataTypeLabel(sourceType) {
  return WEATHER_DATA_TYPE_LABELS[sourceType] ?? "Bilinmeyen veri tipi";
}

export function calculateWeatherConfidence(weather, nowMs = Date.now()) {
  const distanceKm = toNumber(weather?.stationDistanceKm);
  const observedAtMs = weather?.observedAt
    ? new Date(weather.observedAt).getTime()
    : Number.NaN;
  const ageMinutes = Number.isFinite(observedAtMs)
    ? Math.max(0, (nowMs - observedAtMs) / 60000)
    : null;

  if (weather?.sourceType === WEATHER_DATA_TYPES.RUNWAY_MEASUREMENT) {
    return { level: "Yüksek", code: "high", reason: "Pist üstü ölçüm" };
  }

  if (weather?.sourceType === WEATHER_DATA_TYPES.MGM_LIVE) {
    if (distanceKm !== null && distanceKm <= 5) {
      return { level: "Yüksek", code: "high", reason: "Yakın MGM istasyonu" };
    }
    if (distanceKm !== null && distanceKm <= 15) {
      return { level: "Orta", code: "medium", reason: "MGM istasyonu mesafesi" };
    }
    return { level: "Düşük", code: "low", reason: "MGM istasyonu uzak veya belirsiz" };
  }

  if (weather?.sourceType === WEATHER_DATA_TYPES.OPEN_METEO) {
    if (
      (distanceKm !== null && distanceKm > 15) ||
      (ageMinutes !== null && ageMinutes > 60)
    ) {
      return { level: "Düşük", code: "low", reason: "Model noktası uzak veya eski" };
    }
    return { level: "Orta", code: "medium", reason: "Model tahmini" };
  }

  return {
    level: "Düşük",
    code: "low",
    reason: "Pist üstü ölçümle doğrulanmamış kullanıcı girişi",
  };
}

export function normalizeCoordinate(value) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateCoordinate(latitudeValue, longitudeValue) {
  const latitude = normalizeCoordinate(latitudeValue);
  const longitude = normalizeCoordinate(longitudeValue);
  const errors = [];

  if (latitude === null || latitude < -90 || latitude > 90) {
    errors.push("Enlem -90 ile +90 arasında olmalıdır.");
  }
  if (longitude === null || longitude < -180 || longitude > 180) {
    errors.push("Boylam -180 ile +180 arasında olmalıdır.");
  }

  return {
    valid: errors.length === 0,
    latitude,
    longitude,
    errors,
  };
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function calculateDistanceKm(latitudeA, longitudeA, latitudeB, longitudeB) {
  const earthRadiusKm = 6371;
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const startLatitude = toRadians(latitudeA);
  const endLatitude = toRadians(latitudeB);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(haversine));
}

export function normalizeWeatherPayload(rawWeather, requestedCoordinates) {
  const current = rawWeather?.current;
  const temperatureC = toNumber(current?.temperature_2m);
  const humidityPercent = toNumber(current?.relative_humidity_2m);
  const pressureHpa = toNumber(current?.pressure_msl);
  const windSpeedMs = toNumber(current?.wind_speed_10m);
  const windDirectionDeg = toNumber(current?.wind_direction_10m);

  if (
    [temperatureC, humidityPercent, pressureHpa, windSpeedMs, windDirectionDeg].some(
      (value) => value === null,
    )
  ) {
    throw new Error("Meteoroloji yanıtında zorunlu alanlar eksik.");
  }

  const modelLatitude = toNumber(rawWeather?.latitude);
  const modelLongitude = toNumber(rawWeather?.longitude);
  const modelDistanceKm =
    modelLatitude !== null &&
    modelLongitude !== null &&
    requestedCoordinates
      ? calculateDistanceKm(
          requestedCoordinates.latitude,
          requestedCoordinates.longitude,
          modelLatitude,
          modelLongitude,
        )
      : null;

  return {
    source: "Open-Meteo",
    sourceType: WEATHER_DATA_TYPES.OPEN_METEO,
    stationName: "Open-Meteo model noktası",
    stationDistanceKm: modelDistanceKm,
    temperatureC,
    humidityPercent,
    pressureHpa,
    windSpeedMs,
    windDirectionDeg,
    gustSpeedMs: toNumber(current?.wind_gusts_10m) ?? "",
    observedAt: current?.time ? `${current.time}Z` : null,
  };
}

export async function fetchWeatherByDistrict(province, district, latitudeValue, longitudeValue) {
  if (!String(province).trim() || !String(district).trim()) {
    throw new Error("Canlı veri için il ve ilçe girilmelidir.");
  }

  const coordinates = validateCoordinate(latitudeValue, longitudeValue);
  if (!coordinates.valid) {
    throw new Error(coordinates.errors.join(" "));
  }

  const params = new URLSearchParams({
    latitude: String(coordinates.latitude),
    longitude: String(coordinates.longitude),
    current: [
      "temperature_2m",
      "relative_humidity_2m",
      "pressure_msl",
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m",
    ].join(","),
    wind_speed_unit: "ms",
    timezone: "GMT",
    forecast_days: "1",
  });

  const response = await fetch(`${FORECAST_API_URL}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Open-Meteo meteoroloji servisi yanıt vermedi.");
  }

  return normalizeWeatherPayload(await response.json(), coordinates);
}

export async function fetchElevationByCoordinates(latitudeValue, longitudeValue) {
  const coordinates = validateCoordinate(latitudeValue, longitudeValue);
  if (!coordinates.valid) {
    throw new Error(coordinates.errors.join(" "));
  }

  const params = new URLSearchParams({
    latitude: String(coordinates.latitude),
    longitude: String(coordinates.longitude),
  });
  const response = await fetch(`${ELEVATION_API_URL}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Rakım servisi yanıt vermedi.");
  }

  const payload = await response.json();
  const elevationM = toNumber(payload?.elevation?.[0]);
  if (elevationM === null) {
    throw new Error("Rakım yanıtı geçersiz.");
  }
  return elevationM;
}

function normalizePlaceName(value) {
  return String(value ?? "")
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9çğıöşü]/g, "");
}

export async function checkLocationDistrictMismatch(
  province,
  district,
  latitudeValue,
  longitudeValue,
) {
  const coordinates = validateCoordinate(latitudeValue, longitudeValue);
  if (!coordinates.valid || !String(province).trim() || !String(district).trim()) {
    return { checked: false, mismatch: false, distanceKm: null };
  }

  const params = new URLSearchParams({
    name: String(district).trim(),
    count: "20",
    language: "tr",
    format: "json",
    countryCode: "TR",
  });
  const response = await fetch(`${GEOCODING_API_URL}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    return { checked: false, mismatch: false, distanceKm: null };
  }

  const results = (await response.json())?.results ?? [];
  const provinceKey = normalizePlaceName(province);
  const districtKey = normalizePlaceName(district);
  const matchingResult =
    results.find((result) => {
      const administrativeNames = [
        result.name,
        result.admin1,
        result.admin2,
        result.admin3,
        result.admin4,
      ].map(normalizePlaceName);
      const provinceMatches = administrativeNames.some((name) => name.includes(provinceKey));
      const districtMatches = administrativeNames.some((name) => name.includes(districtKey));
      return provinceMatches && districtMatches;
    }) ?? null;

  if (!matchingResult) {
    return { checked: false, mismatch: false, distanceKm: null };
  }

  const distanceKm = calculateDistanceKm(
    coordinates.latitude,
    coordinates.longitude,
    matchingResult.latitude,
    matchingResult.longitude,
  );
  return {
    checked: true,
    mismatch: distanceKm > 80,
    distanceKm,
  };
}
