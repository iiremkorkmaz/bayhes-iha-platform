const G = 9.81;
const METERS_PER_DEGREE = 111320;
const SIMULATION_COUNT = 5000;
const DEFAULT_MAP_CENTER = [36.839, 28.764];
const DEFAULT_MAP_ZOOM = 11;
const RECORDS_KEY = "bayhesFlightRecords";

const form = document.querySelector("#rocketForm");
const messages = document.querySelector("#messages");
const mapSection = document.querySelector("#mapSection");
const mapStatus = document.querySelector("#mapStatus");
const calculationMode = document.querySelector("#calculationMode");
const latitudeInput = document.querySelector("#latitude");
const longitudeInput = document.querySelector("#longitude");
const provinceInput = document.querySelector("#province");
const districtInput = document.querySelector("#district");
const weatherProviderInput = document.querySelector("#weatherProvider");
const weatherStatus = document.querySelector("#weatherStatus");
const analysisSummary = document.querySelector("#analysisSummary");
const calibrationStatus = document.querySelector("#calibrationStatus");
const calibrationResult = document.querySelector("#calibrationResult");
const saveFlightButton = document.querySelector("#saveFlightButton");
const toggleRecordsButton = document.querySelector("#toggleRecordsButton");
const recordsContent = document.querySelector("#recordsContent");
const performanceSummary = document.querySelector("#performanceSummary");
const recordsList = document.querySelector("#recordsList");
const recordDetail = document.querySelector("#recordDetail");
const exportCsvButton = document.querySelector("#exportCsvButton");
const clearRecordsButton = document.querySelector("#clearRecordsButton");
const weatherApi = window.BayhesWeatherProviders;

const output = {
  apogee: document.querySelector("#apogeeResult"),
  descentTime: document.querySelector("#descentTimeResult"),
  windDrift: document.querySelector("#windDriftResult"),
  horizontal: document.querySelector("#horizontalResult"),
  distance: document.querySelector("#distanceResult"),
  innerRisk: document.querySelector("#innerRiskResult"),
  middleRisk: document.querySelector("#middleRiskResult"),
  outerRisk: document.querySelector("#outerRiskResult"),
  simulationCount: document.querySelector("#simulationCountResult"),
  coordinate: document.querySelector("#coordinateResult"),
  density: document.querySelector("#densityResult"),
  stability: document.querySelector("#stabilityResult"),
  usedDescentSpeed: document.querySelector("#usedDescentSpeedResult"),
  risk50: document.querySelector("#risk50Result"),
  risk80: document.querySelector("#risk80Result"),
  risk95: document.querySelector("#risk95Result"),
  risk99: document.querySelector("#risk99Result")
};

let map;
let view;
let baseLayer;
let launchSource;
let resultSource;
let simulationSource;
let riskSource;
let launchLayer;
let resultLayer;
let simulationLayer;
let riskLayer;
let actualSource;
let actualLayer;
let weatherRequestToken = 0;
let currentAnalysis = null;
let currentValues = null;
let currentMeanCoordinate = null;
let currentWeatherSnapshot = null;

function parseNumericInput(value) {
  return weatherApi.parseLocalizedNumber(value);
}

function numberValue(id) {
  const element = document.querySelector(`#${id}`);
  if (!element) return null;

  return parseNumericInput(element.value);
}

function textValue(id) {
  const element = document.querySelector(`#${id}`);
  return element ? element.value.trim() : "";
}

function selectValue(id) {
  const element = document.querySelector(`#${id}`);
  return element ? element.value : "";
}

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function wrapDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function varyPercent(value, percent) {
  return value * randomBetween(1 - percent, 1 + percent);
}

function formatSquareMeters(value) {
  return `${value.toLocaleString("tr-TR", { maximumFractionDigits: 4 })} m²`;
}

function formatDensity(value) {
  return `${value.toLocaleString("tr-TR", { maximumFractionDigits: 3 })} kg/m³`;
}

function formatMeters(value) {
  return `${value.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} m`;
}

function formatSeconds(value) {
  return `${value.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} sn`;
}

function formatSpeed(value) {
  return `${value.toLocaleString("tr-TR", { maximumFractionDigits: 2 })} m/s`;
}

function formatPercent(value) {
  return `%${value.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
}

function formatCoordinate(lat, lon) {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

function setMessage(items, type = "warning") {
  messages.className = `message-box ${type}`;
  messages.innerHTML = `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function setWeatherStatus(message, tone = "info") {
  if (!weatherStatus) return;
  weatherStatus.className = `weather-status ${tone}`;
  weatherStatus.textContent = message;
}

function assignNumericField(selector, value, digits = 1) {
  const element = document.querySelector(selector);
  if (!element || value === null || value === undefined || !Number.isFinite(Number(value))) {
    return;
  }
  element.value = Number(value).toFixed(digits);
}

function selectedWeatherProvider() {
  return weatherApi.getProvider(weatherProviderInput?.value || "open-meteo");
}

function formatWeatherTimestamp(value, { utc = false } = {}) {
  if (!value) return "servis zamanı bildirmedi";

  const timestamp = String(value);
  const normalizedTimestamp = utc && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)
    ? `${timestamp}Z`
    : timestamp;
  const date = new Date(normalizedTimestamp);

  if (!Number.isFinite(date.getTime())) return timestamp;
  return date.toLocaleString("tr-TR", utc ? { timeZone: "UTC" } : undefined)
    + (utc ? " UTC" : " yerel saat");
}

async function fetchElevationForCoordinates(latitudeValue, longitudeValue) {
  const latitude = Number(latitudeValue);
  const longitude = Number(longitudeValue);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("Geçerli koordinatlar girilmedi.");
  }

  const params = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude) });
  const payload = await weatherApi.requestJson(`https://api.open-meteo.com/v1/elevation?${params.toString()}`);
  const elevationM = Number(payload?.elevation?.[0]);
  if (!Number.isFinite(elevationM)) {
    throw new Error("Rakım yanıtı geçersiz.");
  }

  return elevationM;
}

async function resolveLocationFromCoordinates(latitudeValue, longitudeValue) {
  const latitude = Number(latitudeValue);
  const longitude = Number(longitudeValue);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  const openMeteoParams = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    language: "tr",
    format: "json",
  });

  try {
    const payload = await weatherApi.requestJson(
      `https://geocoding-api.open-meteo.com/v1/reverse?${openMeteoParams.toString()}`,
    );
    const match = payload?.results?.[0];
    if (match) {
      const province = String(match.admin1 || match.country || "").trim();
      const district = String(match.admin2 || match.name || match.admin3 || "").trim();
      return {
        province: province || "Türkiye",
        district: district || "Merkez",
      };
    }
  } catch {
    // Open-Meteo reverse geocoding olabilir 404 / devre dışı; sonraki yedeğe geç.
  }

  try {
    const bigDataCloudUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&localityLanguage=tr`;
    const payload = await weatherApi.requestJson(bigDataCloudUrl);
    const province = String(payload?.principalSubdivision || payload?.countryName || "").trim();
    const district = String(payload?.city || payload?.locality || payload?.principalSubdivision || "").trim();

    return {
      province: province || "Türkiye",
      district: district || "Merkez",
    };
  } catch {
    return null;
  }
}

function applyWeatherSnapshot(weatherSnapshot) {
  assignNumericField("#temperatureC", weatherSnapshot.temperatureC, 1);
  assignNumericField("#pressureHpa", weatherSnapshot.pressureHpa, 1);
  assignNumericField("#humidity", weatherSnapshot.humidityPercent, 0);
  assignNumericField("#windSpeed", weatherSnapshot.windSpeedMs, 1);
  assignNumericField("#windDirection", weatherSnapshot.windDirectionDeg, 0);

}

async function refreshWeatherFromCoordinates(
  latitudeValue = numberValue("latitude"),
  longitudeValue = numberValue("longitude"),
) {
  const provider = selectedWeatherProvider();
  currentWeatherSnapshot = null;

  if (latitudeValue === null || longitudeValue === null) {
    if (provider.name === "MGM") {
      setWeatherStatus("MGM verisi alınmadı: yetkili sayısal servis/FTP erişimi ve erişim bilgileri bekleniyor.", "error");
    } else {
      setWeatherStatus("Koordinat seçildiğinde Open-Meteo verisi çekilecek.", "info");
    }
    return;
  }

  let latitude;
  let longitude;
  try {
    latitude = weatherApi.parseCoordinate(latitudeValue, "Enlem", -90, 90);
    longitude = weatherApi.parseCoordinate(longitudeValue, "Boylam", -180, 180);
  } catch (error) {
    setWeatherStatus(`${provider.name} verisi alınmadı: ${error.message}`, "error");
    return;
  }

  const requestId = ++weatherRequestToken;
  setWeatherStatus(`${provider.name} verisi yükleniyor...`, "loading");
  const [weatherResult, locationResult, elevationResult] = await Promise.allSettled([
    provider.fetchSnapshot({ latitude, longitude }),
    provider.id === "open-meteo" ? resolveLocationFromCoordinates(latitude, longitude) : Promise.resolve(null),
    provider.id === "open-meteo" ? fetchElevationForCoordinates(latitude, longitude) : Promise.resolve(null),
  ]);

  if (requestId !== weatherRequestToken) return;

  const resolvedLocation = locationResult.status === "fulfilled" ? locationResult.value : null;
  if (resolvedLocation) {
    provinceInput.value = provinceInput.value.trim() || resolvedLocation.province;
    districtInput.value = districtInput.value.trim() || resolvedLocation.district;
  }

  if (weatherResult.status === "fulfilled") {
    currentWeatherSnapshot = weatherResult.value;
    applyWeatherSnapshot(weatherResult.value);
    const selectedProvince = (provinceInput.value || resolvedLocation?.province || "Türkiye").trim();
    const selectedDistrict = (districtInput.value || resolvedLocation?.district || "Merkez").trim();
    const snapshot = weatherResult.value;
    const validTimeLabel = ({ observation: "Ölçüm zamanı", forecast: "Tahmin zamanı", model: "Model zamanı" })[snapshot.timeKind] || "Veri zamanı";
    const gustText = snapshot.windGustMs === null ? "bilinmiyor" : `${snapshot.windGustMs.toFixed(1)} m/s`;
    setWeatherStatus(
      `${snapshot.source} • ${selectedProvince} / ${selectedDistrict} • ${snapshot.temperatureC.toFixed(1)}°C • ${snapshot.windSpeedMs.toFixed(1)} m/s • Hamle: ${gustText} • İstasyon: ${snapshot.stationCode || "bilinmiyor"} • ${validTimeLabel}: ${formatWeatherTimestamp(snapshot.validAt, { utc: true })} • Alındı: ${formatWeatherTimestamp(snapshot.retrievedAt)} • Durum: güncel`,
      "success",
    );
  } else {
    currentWeatherSnapshot = null;
    setWeatherStatus(
      `${provider.name} verisi alınamadı: ${weatherResult.reason?.message || "servis yanıtı geçersiz."} Önceki alan değerleri yeni veri olarak güncellenmedi.`,
      "error",
    );
  }

  if (elevationResult.status === "fulfilled" && elevationResult.value !== null) {
    const launchAltitudeInput = document.querySelector("#launchAltitude");
    const currentAltitude = numberValue("launchAltitude");
    const altitudeValue = Math.round(elevationResult.value);

    if (launchAltitudeInput && (currentAltitude === null || currentAltitude === 0)) {
      launchAltitudeInput.value = String(altitudeValue);
    }
  }
}

function parseThrustCurve(text) {
  const points = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/[,\s;]+/).map((part) => Number(part.replace(",", "."))))
    .filter(([time, thrust]) => Number.isFinite(time) && Number.isFinite(thrust))
    .sort((a, b) => a[0] - b[0]);

  if (points.length < 2) return null;

  let impulse = 0;
  for (let index = 1; index < points.length; index += 1) {
    const [t0, f0] = points[index - 1];
    const [t1, f1] = points[index];
    impulse += Math.max(0, t1 - t0) * (f0 + f1) / 2;
  }

  const burnTime = Math.max(0.01, points[points.length - 1][0] - points[0][0]);
  return {
    points,
    impulse,
    burnTime,
    averageThrust: impulse / burnTime
  };
}

function calculateAirDensity(values) {
  if (values.manualDensity !== null) return values.manualDensity;

  const temperatureK = (values.temperatureC ?? 20) + 273.15;
  const pressurePa = (values.pressureHpa ?? 1013.25) * 100;
  const altitude = values.launchAltitude ?? 0;
  const altitudeFactor = Math.max(0.7, 1 - altitude / 44330) ** 5.255;
  const humidityFactor = 1 - clamp((values.humidity ?? 50) / 100, 0, 1) * 0.012;
  return pressurePa * altitudeFactor / (287.05 * temperatureK) * humidityFactor;
}

function parachuteArea(diameterCm) {
  const diameterM = Math.max(0.01, (diameterCm ?? 60) / 100);
  return Math.PI * (diameterM / 2) ** 2;
}

function rocketReferenceArea(diameterMm) {
  const diameterM = Math.max(0.001, (diameterMm ?? 60) / 1000);
  return Math.PI * (diameterM / 2) ** 2;
}

function calculateDescentSpeed(values, density) {
  if (values.descentSpeed !== null) return values.descentSpeed;

  const area = parachuteArea(values.parachuteDiameter);
  const parachuteCd = values.parachuteCd ?? 1.5;
  return Math.sqrt((2 * values.mass * G) / (density * parachuteCd * area));
}

function stabilitySettings(values) {
  const status = values.stabilityStatus || "unknown";
  const labels = {
    high: "Yüksek stabilite",
    normal: "Normal stabilite",
    low: "Düşük stabilite",
    unknown: "Bilinmiyor"
  };
  const angleUncertainty = {
    high: 1,
    normal: 3,
    low: 7,
    unknown: 5
  }[status] ?? 5;

  const directionUncertainty = values.directionUncertainty ?? {
    high: 3,
    normal: 5,
    low: 10,
    unknown: 8
  }[status] ?? 8;

  return {
    label: labels[status] ?? labels.unknown,
    angleUncertainty,
    directionUncertainty
  };
}

function enrichValues(values) {
  const thrustCurve = parseThrustCurve(values.thrustCurve);
  const density = calculateAirDensity(values);
  const descentSpeed = calculateDescentSpeed(values, density);
  const stability = stabilitySettings(values);
  const diameterArea = rocketReferenceArea(values.rocketDiameter);

  let stabilityCaliber = values.stabilityCaliber;
  if (stabilityCaliber === null && values.cgPoint !== null && values.cpPoint !== null && values.rocketDiameter) {
    stabilityCaliber = (values.cpPoint - values.cgPoint) / (values.rocketDiameter / 10);
  }

  return {
    ...values,
    thrustCurve,
    effectiveThrust: thrustCurve?.averageThrust ?? values.thrust,
    effectiveBurnTime: thrustCurve?.burnTime ?? values.burnTime,
    calculatedDensity: density,
    usedDescentSpeed: descentSpeed,
    referenceArea: diameterArea,
    stability,
    stabilityCaliber
  };
}

function resetOutputs() {
  output.apogee.textContent = "-";
  output.descentTime.textContent = "-";
  output.windDrift.textContent = "-";
  output.horizontal.textContent = "-";
  output.distance.textContent = "-";
  output.innerRisk.textContent = "-";
  output.middleRisk.textContent = "-";
  output.outerRisk.textContent = "-";
  output.simulationCount.textContent = "-";
  output.coordinate.textContent = "Koordinat girilmedi";
  output.density.textContent = "-";
  output.stability.textContent = "-";
  output.usedDescentSpeed.textContent = "-";
  output.risk50.textContent = "-";
  output.risk80.textContent = "-";
  output.risk95.textContent = "-";
  output.risk99.textContent = "-";
  calculationMode.textContent = "Hazır";
  analysisSummary.textContent = "Girilen parametrelerle Monte Carlo senaryo analizi başlatıldığında tahmini düşüş bölgesi ve risk yoğunluk alanları hesaplanır.";
  currentAnalysis = null;
  currentValues = null;
  currentMeanCoordinate = null;
  clearMapResults();
}

function validateInputs(values) {
  const errors = [];

  if (!Number.isFinite(values.mass) || values.mass <= 0) errors.push("Roket kütlesi pozitif olmalıdır.");
  if (!Number.isFinite(values.thrust) || values.thrust <= 0) errors.push("Motor itki ortalaması pozitif olmalıdır.");
  if (!Number.isFinite(values.burnTime) || values.burnTime <= 0) errors.push("Motor yanma süresi pozitif olmalıdır.");
  if (!Number.isFinite(values.launchAngle) || values.launchAngle < 0 || values.launchAngle > 90) {
    errors.push("Fırlatma açısı 0 ile 90 derece arasında olmalıdır.");
  }
  if (!Number.isFinite(values.windSpeed) || values.windSpeed < 0) errors.push("Rüzgâr hızı negatif olamaz.");
  if (!Number.isFinite(values.windDirection) || values.windDirection < 0 || values.windDirection > 360) {
    errors.push("Rüzgâr yönü 0 ile 360 derece arasında olmalıdır.");
  }
  if (!Number.isFinite(values.temperatureC) || values.temperatureC < -100 || values.temperatureC > 70) {
    errors.push("Sıcaklık -100 ile 70 °C arasında olmalıdır.");
  }
  if (!Number.isFinite(values.pressureHpa) || values.pressureHpa < 300 || values.pressureHpa > 1200) {
    errors.push("Basınç 300 ile 1200 hPa arasında olmalıdır.");
  }
  if (!Number.isFinite(values.humidity) || values.humidity < 0 || values.humidity > 100) {
    errors.push("Bağıl nem 0 ile 100 arasında olmalıdır.");
  }
  if (values.descentSpeed !== null && (!Number.isFinite(values.descentSpeed) || values.descentSpeed <= 0)) {
    errors.push("Paraşütlü iniş hızı girilecekse pozitif olmalıdır.");
  }
  if (!Number.isFinite(values.safetyFactor) || values.safetyFactor <= 0) {
    errors.push("Güvenlik katsayısı pozitif olmalıdır.");
  }
  if (values.manualApogee !== null && (!Number.isFinite(values.manualApogee) || values.manualApogee <= 0)) {
    errors.push("Manuel tepe irtifası girilecekse pozitif olmalıdır.");
  }

  const hasLat = values.latitude !== null;
  const hasLon = values.longitude !== null;
  if (!hasLat || !hasLon) errors.push("Risk haritası için atış enlemi ve boylamı girilmelidir.");
  if (hasLat && (!Number.isFinite(values.latitude) || values.latitude < -90 || values.latitude > 90)) {
    errors.push("Enlem -90 ile 90 arasında olmalıdır.");
  }
  if (hasLat && Math.abs(values.latitude) >= 89.999) {
    errors.push("Kutup noktalarına çok yakın enlemlerde basit boylam hesabı güvenilir değildir.");
  }
  if (hasLon && (!Number.isFinite(values.longitude) || values.longitude < -180 || values.longitude > 180)) {
    errors.push("Boylam -180 ile 180 arasında olmalıdır.");
  }
  if (!Number.isFinite(values.scenarioCount) || values.scenarioCount < 1000) {
    errors.push("Senaryo sayısı en az 1000 olmalıdır.");
  }
  if (values.manualDensity !== null && (!Number.isFinite(values.manualDensity) || values.manualDensity <= 0)) {
    errors.push("Manuel hava yoğunluğu pozitif olmalıdır.");
  }
  if ((values.parachuteDiameter ?? 60) <= 0) {
    errors.push("Paraşüt çapı pozitif olmalıdır.");
  }

  return errors;
}

function calculate(values) {
  // Basit model korunur; Monte Carlo her senaryoda bu modeli küçük sapmalarla tekrar çalıştırır.
  const thrust = values.effectiveThrust ?? values.thrust;
  const burnTime = values.effectiveBurnTime ?? values.burnTime;
  const density = values.calculatedDensity ?? 1.225;
  const rocketCd = values.rocketCd ?? 0.75;
  const referenceArea = values.referenceArea ?? rocketReferenceArea(values.rocketDiameter);
  const acceleration = thrust / values.mass - G;
  const rawBurnoutVelocity = acceleration * burnTime;
  const dragAcceleration = 0.5 * density * Math.max(0, rawBurnoutVelocity) ** 2 * rocketCd * referenceArea / values.mass;
  const burnoutVelocity = Math.max(0, rawBurnoutVelocity - dragAcceleration * burnTime * 0.25);
  const adjustedAcceleration = burnoutVelocity / burnTime;
  const h1 = 0.5 * adjustedAcceleration * burnTime ** 2;
  const h2 = burnoutVelocity ** 2 / (2 * G);
  const calculatedApogee = h1 + h2;
  const densityFactor = values.airDensityFactor ?? 1;
  const densityAltitudeFactor = clamp(1 - (densityFactor - 1) * 0.18, 0.85, 1.15);
  const apogee = values.manualApogee ?? calculatedApogee * densityAltitudeFactor;

  const angleRad = toRadians(values.launchAngle);
  const verticalVelocity = burnoutVelocity * Math.sin(angleRad);
  const horizontalVelocity = burnoutVelocity * Math.cos(angleRad);
  const climbTime = Math.max(0, verticalVelocity / G);
  const horizontalDistance = Math.max(0, horizontalVelocity * climbTime);
  const descentTime = apogee / values.usedDescentSpeed;
  const driftUncertainty = values.driftFactor ?? 1;
  const windDrift = values.windSpeed * descentTime * driftUncertainty * clamp(densityFactor, 0.95, 1.05);
  const totalDistance = horizontalDistance + windDrift;

  return {
    acceleration,
    calculatedApogee,
    apogee,
    descentTime,
    windDrift,
    horizontalDistance,
    totalDistance
  };
}

function makeScenario(baseValues) {
  const windVariability = (baseValues.windVariability ?? 25) / 100;
  const directionVariability = baseValues.windDirectionVariability ?? 15;
  const hasUpperWind = baseValues.upperWindSpeed !== null || baseValues.upperWindDirection !== null;
  const windExpansion = hasUpperWind ? 1 : 1.25;
  const upperMix = Math.random();
  const windSpeedBase = hasUpperWind
    ? (baseValues.windSpeed * (1 - upperMix) + (baseValues.upperWindSpeed ?? baseValues.windSpeed) * upperMix)
    : baseValues.windSpeed;
  const windDirectionBase = hasUpperWind
    ? wrapDegrees(baseValues.windDirection * (1 - upperMix) + (baseValues.upperWindDirection ?? baseValues.windDirection) * upperMix)
    : baseValues.windDirection;
  const deploymentUncertainty = baseValues.deploymentUncertainty ?? 0.5;
  const deploymentFactor = {
    normal: 1,
    late: 1.12,
    unknown: 1.08
  }[baseValues.deploymentAssumption] ?? 1.08;

  return {
    ...baseValues,
    effectiveThrust: varyPercent(baseValues.effectiveThrust, 0.10),
    effectiveBurnTime: varyPercent(baseValues.effectiveBurnTime, 0.08),
    rocketCd: varyPercent(baseValues.rocketCd ?? 0.75, 0.15),
    parachuteCd: varyPercent(baseValues.parachuteCd ?? 1.5, 0.20),
    launchAngle: clamp(baseValues.launchAngle + randomBetween(-baseValues.stability.angleUncertainty, baseValues.stability.angleUncertainty), 0, 90),
    launchAzimuth: wrapDegrees((baseValues.launchAzimuth ?? 0) + randomBetween(-baseValues.stability.directionUncertainty, baseValues.stability.directionUncertainty)),
    windSpeed: Math.max(0, varyPercent(windSpeedBase, windVariability * windExpansion)),
    windDirection: wrapDegrees(windDirectionBase + randomBetween(-directionVariability * windExpansion, directionVariability * windExpansion)),
    usedDescentSpeed: Math.max(0.01, varyPercent(baseValues.usedDescentSpeed, 0.20)),
    airDensityFactor: randomBetween(0.95, 1.05),
    calculatedDensity: varyPercent(baseValues.calculatedDensity, 0.05),
    driftFactor: randomBetween(0.85, 1.15) * deploymentFactor * (1 + randomBetween(-deploymentUncertainty, deploymentUncertainty) * 0.05),
    extraAlongFactor: randomBetween(-0.08, 0.08) * (baseValues.stability.angleUncertainty / 3),
    extraCrossFactor: randomBetween(-0.06, 0.06) * (baseValues.stability.directionUncertainty / 5)
  };
}

function offsetFromDistance(distance, directionDegrees) {
  const directionRad = toRadians(directionDegrees);
  return {
    east: distance * Math.sin(directionRad),
    north: distance * Math.cos(directionRad)
  };
}

function coordinateFromOffset(latitude, longitude, east, north) {
  const latitudeRad = toRadians(latitude);
  return {
    latitude: latitude + north / METERS_PER_DEGREE,
    longitude: longitude + east / (METERS_PER_DEGREE * Math.cos(latitudeRad))
  };
}

function mean(items, key) {
  return items.reduce((total, item) => total + item[key], 0) / items.length;
}

function analyzePrincipalAxes(points, meanEast, meanNorth) {
  const covariance = points.reduce((acc, point) => {
    const dx = point.east - meanEast;
    const dy = point.north - meanNorth;

    acc.ee += dx * dx;
    acc.nn += dy * dy;
    acc.en += dx * dy;
    return acc;
  }, { ee: 0, nn: 0, en: 0 });

  covariance.ee /= points.length;
  covariance.nn /= points.length;
  covariance.en /= points.length;

  const trace = covariance.ee + covariance.nn;
  const delta = Math.sqrt((covariance.ee - covariance.nn) ** 2 + 4 * covariance.en ** 2);
  const majorVariance = Math.max((trace + delta) / 2, 1);
  const minorVariance = Math.max((trace - delta) / 2, 1);
  const angle = 0.5 * Math.atan2(2 * covariance.en, covariance.ee - covariance.nn);

  const majorVector = { east: Math.cos(angle), north: Math.sin(angle) };
  const minorVector = { east: -Math.sin(angle), north: Math.cos(angle) };

  return {
    majorVector,
    minorVector,
    majorSpread: Math.sqrt(majorVariance),
    minorSpread: Math.sqrt(minorVariance)
  };
}

function projectPoint(point, meanEast, meanNorth, axes) {
  const dx = point.east - meanEast;
  const dy = point.north - meanNorth;

  return {
    major: dx * axes.majorVector.east + dy * axes.majorVector.north,
    minor: dx * axes.minorVector.east + dy * axes.minorVector.north
  };
}

function percentile(sortedValues, ratio) {
  const index = Math.ceil(sortedValues.length * ratio) - 1;
  return sortedValues[clamp(index, 0, sortedValues.length - 1)];
}

function simulate(baseValues) {
  const points = [];
  let rejected = 0;

  for (let index = 0; index < baseValues.scenarioCount; index += 1) {
    const scenario = makeScenario(baseValues);
    const result = calculate(scenario);

    if (!Number.isFinite(result.apogee) || result.apogee <= 0) {
      rejected += 1;
      continue;
    }

    const windOffset = offsetFromDistance(result.windDrift, scenario.windDirection);
    const launchOffset = offsetFromDistance(result.horizontalDistance, scenario.launchAzimuth ?? 0);
    const directionRad = toRadians(scenario.windDirection);
    const extraAlong = result.totalDistance * scenario.extraAlongFactor;
    const extraCross = result.totalDistance * scenario.extraCrossFactor;
    const east = windOffset.east + launchOffset.east + extraAlong * Math.sin(directionRad) + extraCross * Math.cos(directionRad);
    const north = windOffset.north + launchOffset.north + extraAlong * Math.cos(directionRad) - extraCross * Math.sin(directionRad);

    points.push({
      ...result,
      east,
      north,
      totalDistance: Math.hypot(east, north)
    });
  }

  if (points.length === 0) {
    return null;
  }

  const meanEast = mean(points, "east");
  const meanNorth = mean(points, "north");
  const meanDistance = Math.hypot(meanEast, meanNorth);
  const axes = analyzePrincipalAxes(points, meanEast, meanNorth);
  const projectedPoints = points.map((point) => projectPoint(point, meanEast, meanNorth, axes));
  const normalizedDistances = projectedPoints
    .map((projection) => Math.hypot(projection.major / axes.majorSpread, projection.minor / axes.minorSpread))
    .sort((a, b) => a - b);

  const riskBands = [
    makeRiskBand("risk50", "%50 kapsama alanı", "#28d39a", 0.50, normalizedDistances, axes),
    makeRiskBand("risk80", "%80 kapsama alanı", "#f3b64a", 0.80, normalizedDistances, axes),
    makeRiskBand("risk95", "%95 güvenlik alanı", "#ff8f3d", 0.95, normalizedDistances, axes),
    makeRiskBand("risk99", "%99 maksimum güvenlik alanı", "#ff5c7a", 0.99, normalizedDistances, axes)
  ];

  return {
    points,
    rejected,
    meanEast,
    meanNorth,
    meanDistance,
    averageApogee: mean(points, "apogee"),
    averageDescentTime: mean(points, "descentTime"),
    averageWindDrift: mean(points, "windDrift"),
    averageHorizontalDistance: mean(points, "horizontalDistance"),
    axes,
    riskBands
  };
}

function makeRiskBand(name, label, color, target, normalizedDistances, axes) {
  const scale = percentile(normalizedDistances, target);
  const covered = normalizedDistances.filter((distance) => distance <= scale).length;
  const equivalentRadius = Math.sqrt((scale * axes.majorSpread) * (scale * axes.minorSpread));

  return {
    name,
    label,
    color,
    radius: equivalentRadius,
    majorAxis: scale * axes.majorSpread,
    minorAxis: scale * axes.minorSpread,
    coverage: covered / normalizedDistances.length * 100
  };
}

function readValues() {
  return {
    rocketName: textValue("rocketName"),
    mass: numberValue("mass"),
    thrust: numberValue("thrust"),
    burnTime: numberValue("burnTime"),
    launchAngle: numberValue("launchAngle"),
    windSpeed: numberValue("windSpeed"),
    windDirection: numberValue("windDirection"),
    descentSpeed: numberValue("descentSpeed"),
    manualApogee: numberValue("manualApogee"),
    latitude: numberValue("latitude"),
    longitude: numberValue("longitude"),
    safetyFactor: numberValue("safetyFactor"),
    scenarioCount: Number(selectValue("scenarioCount") || SIMULATION_COUNT),
    rocketLength: numberValue("rocketLength"),
    rocketDiameter: numberValue("rocketDiameter") ?? 60,
    rocketCd: numberValue("rocketCd") ?? 0.75,
    noseType: selectValue("noseType"),
    finCount: numberValue("finCount"),
    finDescription: textValue("finDescription"),
    motorName: textValue("motorName"),
    totalImpulse: numberValue("totalImpulse"),
    delayTime: numberValue("delayTime") ?? 0,
    thrustCurve: textValue("thrustCurve"),
    launchAltitude: numberValue("launchAltitude") ?? 0,
    launchAzimuth: numberValue("launchAzimuth") ?? 0,
    railLength: numberValue("railLength"),
    directionUncertainty: numberValue("directionUncertainty"),
    temperatureC: numberValue("temperatureC") ?? 20,
    pressureHpa: numberValue("pressureHpa") ?? 1013.25,
    humidity: numberValue("humidity") ?? 50,
    manualDensity: numberValue("manualDensity"),
    upperWindSpeed: numberValue("upperWindSpeed"),
    upperWindDirection: numberValue("upperWindDirection"),
    windVariability: numberValue("windVariability") ?? 25,
    windDirectionVariability: numberValue("windDirectionVariability") ?? 15,
    windLayers: textValue("windLayers"),
    parachuteDiameter: numberValue("parachuteDiameter") ?? 60,
    parachuteCd: numberValue("parachuteCd") ?? 1.5,
    deploymentUncertainty: numberValue("deploymentUncertainty") ?? 0.5,
    deploymentAssumption: selectValue("deploymentAssumption"),
    stabilityStatus: selectValue("stabilityStatus"),
    stabilityCaliber: numberValue("stabilityCaliber"),
    cgPoint: numberValue("cgPoint"),
    cpPoint: numberValue("cpPoint")
  };
}

function renderResults(values, analysis) {
  const [risk50, risk80, risk95, risk99] = analysis.riskBands;

  output.apogee.textContent = formatMeters(analysis.averageApogee);
  output.descentTime.textContent = formatSeconds(analysis.averageDescentTime);
  output.windDrift.textContent = formatMeters(analysis.averageWindDrift);
  output.horizontal.textContent = formatMeters(analysis.averageHorizontalDistance);
  output.distance.textContent = formatMeters(analysis.meanDistance);
  output.innerRisk.textContent = `${formatPercent(risk50.coverage)} (${formatMeters(risk50.radius)})`;
  output.middleRisk.textContent = `${formatPercent(risk80.coverage)} (${formatMeters(risk80.radius)})`;
  output.outerRisk.textContent = `${formatPercent(risk95.coverage)} (${formatMeters(risk95.radius)})`;
  output.simulationCount.textContent = analysis.points.length.toLocaleString("tr-TR");
  output.density.textContent = formatDensity(values.calculatedDensity);
  output.stability.textContent = values.stability.label;
  output.usedDescentSpeed.textContent = formatSpeed(values.usedDescentSpeed);
  output.risk50.textContent = `${formatPercent(risk50.coverage)} | ${formatMeters(risk50.majorAxis)} x ${formatMeters(risk50.minorAxis)}`;
  output.risk80.textContent = `${formatPercent(risk80.coverage)} | ${formatMeters(risk80.majorAxis)} x ${formatMeters(risk80.minorAxis)}`;
  output.risk95.textContent = `${formatPercent(risk95.coverage)} | ${formatMeters(risk95.majorAxis)} x ${formatMeters(risk95.minorAxis)}`;
  output.risk99.textContent = `${formatPercent(risk99.coverage)} | ${formatMeters(risk99.majorAxis)} x ${formatMeters(risk99.minorAxis)}`;
  calculationMode.textContent = "Analiz tamamlandı";
  analysisSummary.textContent = `Bu analizde girilen parametreler etrafında ${analysis.points.length.toLocaleString("tr-TR")} farklı senaryo üretilmiş, tahmini düşüş noktalarının dağılımı harita üzerinde %50, %80, %95 ve %99 simülasyon kapsama alanları olarak gösterilmiştir. Bu değerler Monte Carlo simülasyonu sonucudur. Gerçek dünya garantisi değildir.`;

  if (values.latitude === null || values.longitude === null) {
    output.coordinate.textContent = "Koordinat girilmedi";
    return;
  }

  const meanCoordinate = coordinateFromOffset(values.latitude, values.longitude, analysis.meanEast, analysis.meanNorth);
  output.coordinate.textContent = formatCoordinate(meanCoordinate.latitude, meanCoordinate.longitude);
  currentMeanCoordinate = meanCoordinate;
}

function refreshMapSize() {
  if (!map) return;

  requestAnimationFrame(() => {
    map.updateSize();
    setTimeout(() => map.updateSize(), 150);
    setTimeout(() => map.updateSize(), 500);
  });
}

function ensureMap(latitude = DEFAULT_MAP_CENTER[0], longitude = DEFAULT_MAP_CENTER[1]) {
  mapSection.classList.remove("is-hidden");

  if (!map) {
    view = new ol.View({
      center: ol.proj.fromLonLat([longitude, latitude]),
      zoom: DEFAULT_MAP_ZOOM
    });

    baseLayer = new ol.layer.Tile({
      source: new ol.source.OSM()
    });

    launchSource = new ol.source.Vector();
    resultSource = new ol.source.Vector();
    simulationSource = new ol.source.Vector();
    riskSource = new ol.source.Vector();
    actualSource = new ol.source.Vector();

    riskLayer = new ol.layer.Vector({ source: riskSource, style: riskStyle });
    simulationLayer = new ol.layer.Vector({ source: simulationSource, style: simulationPointStyle });
    resultLayer = new ol.layer.Vector({ source: resultSource, style: resultStyle });
    launchLayer = new ol.layer.Vector({ source: launchSource, style: launchStyle });
    actualLayer = new ol.layer.Vector({ source: actualSource, style: actualStyle });

    map = new ol.Map({
      target: "map",
      layers: [baseLayer, riskLayer, simulationLayer, resultLayer, launchLayer, actualLayer],
      view
    });

    map.on("click", (event) => {
      const [lng, lat] = ol.proj.toLonLat(event.coordinate);
      latitudeInput.value = lat.toFixed(6);
      longitudeInput.value = lng.toFixed(6);
      setLaunchClickMarker(lat, lng);
      mapStatus.textContent = "Atış konumu seçildi";
      refreshWeatherFromCoordinates();
    });
  }

  refreshMapSize();
}

function markerStyle(color, radius, strokeColor = "#ffffff") {
  return new ol.style.Style({
    image: new ol.style.Circle({
      radius,
      fill: new ol.style.Fill({ color }),
      stroke: new ol.style.Stroke({ color: strokeColor, width: 2 })
    })
  });
}

function lineStyle(color) {
  return new ol.style.Style({
    stroke: new ol.style.Stroke({ color, width: 3 })
  });
}

function polygonStyle(color, opacity, width) {
  return new ol.style.Style({
    fill: new ol.style.Fill({ color: hexToRgba(color, opacity) }),
    stroke: new ol.style.Stroke({ color, width })
  });
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function launchStyle(feature) {
  return feature.get("kind") === "launch"
    ? markerStyle("#28d39a", 7)
    : markerStyle("#8bdcff", 6);
}

function resultStyle(feature) {
  return feature.getGeometry().getType() === "LineString"
    ? lineStyle("#28d39a")
    : markerStyle("#f3b64a", 7);
}

function actualStyle() {
  return markerStyle("#ff5c7a", 7);
}

function simulationPointStyle() {
  return markerStyle("rgba(139, 220, 255, 0.34)", 2, "rgba(139, 220, 255, 0)");
}

function riskStyle(feature) {
  const color = feature.get("color") ?? "#28d39a";
  const name = feature.get("name");
  const opacity = name === "risk99" ? 0.07 : 0.11;
  const width = name === "risk50" ? 3 : 2;
  const style = polygonStyle(color, opacity, width);
  style.setText(new ol.style.Text({
    text: feature.get("label") ?? "",
    fill: new ol.style.Fill({ color: "#eef4ff" }),
    stroke: new ol.style.Stroke({ color: "rgba(15,20,27,0.85)", width: 4 }),
    font: "700 12px Inter, sans-serif",
    overflow: true
  }));
  return style;
}

function lonLatFeature(longitude, latitude, properties = {}) {
  return new ol.Feature({
    geometry: new ol.geom.Point(ol.proj.fromLonLat([longitude, latitude])),
    ...properties
  });
}

function projectedCoordinate(latitude, longitude) {
  return ol.proj.fromLonLat([longitude, latitude]);
}

function setLaunchClickMarker(latitude, longitude) {
  if (!map) return;

  launchSource.clear();
  launchSource.addFeature(lonLatFeature(longitude, latitude, { kind: "launch" }));
}

function focusMapFromCoordinateInputs() {
  const latitude = numberValue("latitude");
  const longitude = numberValue("longitude");

  if (
    latitude === null ||
    longitude === null ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    Math.abs(latitude) >= 89.999
  ) {
    return;
  }

  ensureMap(latitude, longitude);
  view.animate({ center: projectedCoordinate(latitude, longitude), zoom: 13, duration: 250 });
  setLaunchClickMarker(latitude, longitude);
  mapStatus.textContent = "Atış konumu manuel koordinata göre odaklandı";
  refreshMapSize();
}

function clearMapResults() {
  if (!map) return;

  resultSource.clear();
  simulationSource.clear();
  riskSource.clear();
  actualSource?.clear();
  mapStatus.textContent = "Atış konumu seçmek için haritaya tıklayın";
}

function makeEllipsePolygon(values, analysis, band) {
  const points = [];
  const segments = 96;

  for (let index = 0; index <= segments; index += 1) {
    const angle = index / segments * Math.PI * 2;
    const major = Math.cos(angle) * band.majorAxis;
    const minor = Math.sin(angle) * band.minorAxis;
    const east = analysis.meanEast + major * analysis.axes.majorVector.east + minor * analysis.axes.minorVector.east;
    const north = analysis.meanNorth + major * analysis.axes.majorVector.north + minor * analysis.axes.minorVector.north;
    const coordinate = coordinateFromOffset(values.latitude, values.longitude, east, north);
    points.push([coordinate.latitude, coordinate.longitude]);
  }

  return points;
}

function updateMap(values, analysis) {
  if (values.latitude === null || values.longitude === null) {
    clearMapResults();
    mapStatus.textContent = "Koordinat girilmedi";
    return;
  }

  ensureMap(values.latitude, values.longitude);
  clearMapResults();

  const meanCoordinate = coordinateFromOffset(values.latitude, values.longitude, analysis.meanEast, analysis.meanNorth);
  const launchCoordinate = projectedCoordinate(values.latitude, values.longitude);
  const meanMapCoordinate = projectedCoordinate(meanCoordinate.latitude, meanCoordinate.longitude);

  setLaunchClickMarker(values.latitude, values.longitude);
  resultSource.addFeature(lonLatFeature(meanCoordinate.longitude, meanCoordinate.latitude, { kind: "mean" }));
  resultSource.addFeature(new ol.Feature({
    geometry: new ol.geom.LineString([launchCoordinate, meanMapCoordinate]),
    kind: "path"
  }));

  analysis.points.forEach((point) => {
    const coordinate = coordinateFromOffset(values.latitude, values.longitude, point.east, point.north);
    simulationSource.addFeature(lonLatFeature(coordinate.longitude, coordinate.latitude, { kind: "simulation" }));
  });

  [...analysis.riskBands].reverse().forEach((band) => {
    const ring = makeEllipsePolygon(values, analysis, band)
      .map(([latitude, longitude]) => projectedCoordinate(latitude, longitude));
    riskSource.addFeature(new ol.Feature({
      geometry: new ol.geom.Polygon([ring]),
      name: band.name,
      color: band.color,
      label: `${band.label}: ${formatPercent(band.coverage)}`
    }));
  });

  const extent = ol.extent.createEmpty();
  [launchSource, resultSource, riskSource].forEach((source) => {
    ol.extent.extend(extent, source.getExtent());
  });

  view.fit(extent, {
    padding: [36, 36, 36, 36],
    maxZoom: 15,
    duration: 250
  });
  refreshMapSize();
  mapStatus.textContent = "Risk haritası güncellendi";
}

function metersFromCoordinate(originLat, originLng, latitude, longitude) {
  const north = (latitude - originLat) * METERS_PER_DEGREE;
  const east = (longitude - originLng) * METERS_PER_DEGREE * Math.cos(toRadians(originLat));
  return { east, north };
}

function directionFromOffset(east, north) {
  return wrapDegrees(Math.atan2(east, north) * 180 / Math.PI);
}

function analyzeActualLanding(actualLat, actualLng) {
  if (!currentAnalysis || !currentValues || !currentMeanCoordinate) {
    throw new Error("Önce risk analizi çalıştırılmalıdır.");
  }

  const actualOffset = metersFromCoordinate(currentValues.latitude, currentValues.longitude, actualLat, actualLng);
  const meanOffset = {
    east: currentAnalysis.meanEast,
    north: currentAnalysis.meanNorth
  };
  const errorEast = actualOffset.east - meanOffset.east;
  const errorNorth = actualOffset.north - meanOffset.north;
  const errorMeters = Math.hypot(errorEast, errorNorth);
  const errorDirectionDeg = directionFromOffset(errorEast, errorNorth);
  const projection = {
    major: errorEast * currentAnalysis.axes.majorVector.east + errorNorth * currentAnalysis.axes.majorVector.north,
    minor: errorEast * currentAnalysis.axes.minorVector.east + errorNorth * currentAnalysis.axes.minorVector.north
  };
  const normalized = Math.hypot(
    projection.major / currentAnalysis.axes.majorSpread,
    projection.minor / currentAnalysis.axes.minorSpread
  );
  const containmentBand = currentAnalysis.riskBands.find((band) => normalized <= band.majorAxis / currentAnalysis.axes.majorSpread);
  const containmentArea = containmentBand?.label ?? "Alan dışında";
  const nearestBand = currentAnalysis.riskBands
    .map((band) => {
      const scale = band.majorAxis / currentAnalysis.axes.majorSpread;
      const boundaryMeters = Math.abs(normalized - scale) * Math.sqrt(band.majorAxis * band.minorAxis);
      return { band, boundaryMeters };
    })
    .sort((a, b) => a.boundaryMeters - b.boundaryMeters)[0];

  return {
    actualLat,
    actualLng,
    errorMeters,
    errorDirectionDeg,
    containmentArea,
    boundaryMeters: nearestBand.boundaryMeters,
    summary: containmentArea === "Alan dışında"
      ? `Gerçek düşüş noktası %99 maksimum güvenlik alanının dışında kaldı; simülasyon merkezinden ${formatMeters(errorMeters)} sapma hesaplandı. Model kalibrasyonu önerilir.`
      : `Gerçek düşüş noktası ${containmentArea} içinde değerlendirildi; simülasyon merkezinden ${formatMeters(errorMeters)} sapma hesaplandı.`
  };
}

function addActualMarker(latitude, longitude) {
  if (!map || !actualSource) return;

  actualSource.clear();
  actualSource.addFeature(lonLatFeature(longitude, latitude, { kind: "actual" }));
  refreshMapSize();
}

function loadRecords() {
  try {
    return JSON.parse(localStorage.getItem(RECORDS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveRecords(records) {
  localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
}

function recordFromCurrentAnalysis(actualAnalysis) {
  return {
    id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
    date: new Date().toISOString(),
    rocketName: currentValues.rocketName || "İsimsiz test",
    motorName: currentValues.motorName || "Belirtilmedi",
    launchLat: currentValues.latitude,
    launchLng: currentValues.longitude,
    predictedLat: currentMeanCoordinate.latitude,
    predictedLng: currentMeanCoordinate.longitude,
    actualLat: actualAnalysis.actualLat,
    actualLng: actualAnalysis.actualLng,
    errorMeters: actualAnalysis.errorMeters,
    errorDirectionDeg: actualAnalysis.errorDirectionDeg,
    containmentArea: actualAnalysis.containmentArea,
    boundaryMeters: actualAnalysis.boundaryMeters,
    parachuteStatus: selectValue("actualParachuteStatus"),
    observation: selectValue("actualObservation"),
    scenarioCount: currentAnalysis.points.length,
    notes: textValue("actualNotes"),
    inputs: currentValues,
    results: {
      averageApogee: currentAnalysis.averageApogee,
      averageDescentTime: currentAnalysis.averageDescentTime,
      averageWindDrift: currentAnalysis.averageWindDrift,
      averageHorizontalDistance: currentAnalysis.averageHorizontalDistance,
      meanDistance: currentAnalysis.meanDistance,
      riskBands: currentAnalysis.riskBands
    }
  };
}

function renderPerformanceSummary(records) {
  if (records.length === 0) {
    performanceSummary.innerHTML = `<article class="info-box"><span>Model Performansı</span><p>Henüz kayıtlı gerçek atış verisi yok.</p></article>`;
    return;
  }

  const errors = records.map((record) => record.errorMeters).sort((a, b) => a - b);
  const avg = errors.reduce((total, value) => total + value, 0) / errors.length;
  const median = errors[Math.floor(errors.length / 2)];
  const rank = { "%50 kapsama alanı": 1, "%80 kapsama alanı": 2, "%95 güvenlik alanı": 3, "%99 maksimum güvenlik alanı": 4, "Alan dışında": 5 };
  const within = (limit) => records.filter((record) => (rank[record.containmentArea] ?? 5) <= limit).length;
  const outside = records.filter((record) => record.containmentArea === "Alan dışında").length;

  performanceSummary.innerHTML = `
    <article class="info-box"><span>Toplam kayıt</span><p>${records.length}</p></article>
    <article class="info-box"><span>Ortalama hata</span><p>${formatMeters(avg)}</p></article>
    <article class="info-box"><span>Median hata</span><p>${formatMeters(median)}</p></article>
    <article class="info-box"><span>En düşük / en yüksek hata</span><p>${formatMeters(errors[0])} / ${formatMeters(errors[errors.length - 1])}</p></article>
    <article class="info-box"><span>Kapsama özeti</span><p>%50: ${within(1)} | %80: ${within(2)} | %95: ${within(3)} | %99: ${within(4)} | Dış: ${outside}</p></article>
  `;
}

function renderRecords() {
  const records = loadRecords();
  renderPerformanceSummary(records);

  if (records.length === 0) {
    recordsList.innerHTML = `<div class="message-box">Kayıtlı atış bulunmuyor.</div>`;
    recordDetail.innerHTML = "";
    return;
  }

  recordsList.innerHTML = records.map((record) => {
    const date = new Date(record.date).toLocaleString("tr-TR");
    return `<div class="record-item" data-id="${record.id}">${date} - ${record.rocketName} - Gerçek düşüş ${record.containmentArea}, tahmini merkezden ${formatMeters(record.errorMeters)} sapma.</div>`;
  }).join("");
}

function showRecordDetail(id) {
  const record = loadRecords().find((item) => item.id === id);
  if (!record) return;

  recordDetail.innerHTML = `
    <article class="info-box">
      <span>Kayıt Detayı</span>
      <p>Motor: ${record.motorName}<br>
      Atış: ${formatCoordinate(record.launchLat, record.launchLng)}<br>
      Tahmini merkez: ${formatCoordinate(record.predictedLat, record.predictedLng)}<br>
      Gerçek düşüş: ${formatCoordinate(record.actualLat, record.actualLng)}<br>
      Hata: ${formatMeters(record.errorMeters)} / ${record.errorDirectionDeg.toFixed(1)}°<br>
      Kapsama: ${record.containmentArea}<br>
      En yakın sınır mesafesi: ${formatMeters(record.boundaryMeters)}<br>
      Paraşüt: ${record.parachuteStatus}<br>
      Senaryo: ${record.scenarioCount.toLocaleString("tr-TR")}<br>
      Not: ${record.notes || "Yok"}</p>
      <button class="secondary-button danger-button" type="button" data-delete-id="${record.id}">Kaydı Sil</button>
    </article>
  `;
}

function exportRecordsCsv() {
  const records = loadRecords();
  const header = "date,rocketName,motorName,launchLat,launchLng,predictedLat,predictedLng,actualLat,actualLng,errorMeters,errorDirectionDeg,containmentArea,parachuteStatus,scenarioCount,notes";
  const rows = records.map((record) => [
    record.date,
    record.rocketName,
    record.motorName,
    record.launchLat,
    record.launchLng,
    record.predictedLat,
    record.predictedLng,
    record.actualLat,
    record.actualLng,
    record.errorMeters,
    record.errorDirectionDeg,
    record.containmentArea,
    record.parachuteStatus,
    record.scenarioCount,
    record.notes
  ].map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(","));
  const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "bayhes-onceki-atislar.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function buildWarnings(analysis) {
  const warnings = [
    "Bu sistem kesin düşüş noktası vermez. Gösterilen yüzdeler gerçek dünya garantisi değildir; girilen parametreler ve tanımlanan belirsizlik aralıkları kullanılarak yapılan simülasyona dayalı tahmini risk analizidir. Gerçek rüzgâr profili, hava yoğunluğu, motor performansı, paraşüt açılma davranışı ve uçuş sapmaları sonucu değiştirebilir.",
    "Gerçek atışta açık alan, izin, güvenlik mesafesi ve yerel kurallar dikkate alınmalıdır.",
    "Rüzgâr yüksek irtifada farklı olabilir."
  ];

  if (currentValues) {
    const defaults = [];
    if (currentValues.descentSpeed === null) defaults.push("paraşüt iniş hızı hesaplandı");
    if (currentValues.manualDensity === null) defaults.push("hava yoğunluğu sıcaklık/basınç/rakım üzerinden hesaplandı");
    if (!currentValues.thrustCurve) defaults.push("thrust curve yerine ortalama itki kullanıldı");
    if (defaults.length > 0) warnings.push(`Varsayılan/hesaplanan değerler: ${defaults.join(", ")}.`);
  }

  if (analysis.rejected > 0) {
    warnings.unshift(`${analysis.rejected} simülasyon senaryosu negatif veya sıfır tepe irtifası ürettiği için risk hesabına katılmadı.`);
  }

  return warnings;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const rawValues = readValues();
  const errors = validateInputs(rawValues);

  if (errors.length > 0) {
    resetOutputs();
    setMessage(errors, "error");
    return;
  }

  calculationMode.textContent = "Analiz çalışıyor";
  setMessage([
    rawValues.scenarioCount >= 10000
      ? "10000 senaryo seçildi. Analiz kısa süre alabilir."
      : "Monte Carlo senaryo analizi çalışıyor."
  ], "warning");

  const values = enrichValues(rawValues);
  const baseResult = calculate(values);
  if (!Number.isFinite(baseResult.apogee) || baseResult.apogee <= 0) {
    resetOutputs();
    setMessage(["Tepe irtifası negatif veya sıfır çıktı. Kütle, itki ve yanma süresi değerlerini kontrol edin."], "error");
    return;
  }

  const analysis = simulate(values);
  if (!analysis) {
    resetOutputs();
    setMessage(["Simülasyon senaryoları geçerli tahmini iniş noktası üretemedi. Atış parametrelerini kontrol edin."], "error");
    return;
  }

  currentValues = values;
  currentAnalysis = analysis;
  renderResults(values, analysis);
  updateMap(values, analysis);
  setMessage(buildWarnings(analysis), "warning");
});

form.addEventListener("reset", () => {
  window.setTimeout(() => {
    resetOutputs();
    messages.className = "message-box";
    messages.textContent = "Parametreleri girin ve risk analizini başlatın.";
  }, 0);
});

saveFlightButton.addEventListener("click", () => {
  const actualLat = numberValue("actualLatitude");
  const actualLng = numberValue("actualLongitude");

  if (actualLat === null || actualLng === null || !Number.isFinite(actualLat) || !Number.isFinite(actualLng)) {
    calibrationResult.className = "message-box error";
    calibrationResult.textContent = "Gerçek düşüş enlemi ve boylamı geçerli sayı olmalıdır.";
    return;
  }

  try {
    const actualAnalysis = analyzeActualLanding(actualLat, actualLng);
    addActualMarker(actualLat, actualLng);
    const records = loadRecords();
    records.unshift(recordFromCurrentAnalysis(actualAnalysis));
    saveRecords(records);
    renderRecords();
    calibrationStatus.textContent = "Kalibrasyon kaydedildi";
    calibrationResult.className = "message-box warning";
    calibrationResult.textContent = `${actualAnalysis.summary} En yakın risk alanı sınırına yaklaşık ${formatMeters(actualAnalysis.boundaryMeters)} mesafe vardır.`;
  } catch (error) {
    calibrationResult.className = "message-box error";
    calibrationResult.textContent = error.message;
  }
});

toggleRecordsButton.addEventListener("click", () => {
  recordsContent.classList.toggle("is-collapsed");
  toggleRecordsButton.textContent = recordsContent.classList.contains("is-collapsed") ? "Paneli Aç" : "Paneli Kapat";
  renderRecords();
});

recordsList.addEventListener("click", (event) => {
  const item = event.target.closest("[data-id]");
  if (item) showRecordDetail(item.dataset.id);
});

recordDetail.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-id]");
  if (!button) return;

  const records = loadRecords().filter((record) => record.id !== button.dataset.deleteId);
  saveRecords(records);
  renderRecords();
});

clearRecordsButton.addEventListener("click", () => {
  saveRecords([]);
  renderRecords();
});

exportCsvButton.addEventListener("click", exportRecordsCsv);

window.addEventListener("load", () => {
  ensureMap();
  setTimeout(() => {
    if (map) map.updateSize();
  }, 500);
  refreshWeatherFromCoordinates(...DEFAULT_MAP_CENTER);
});

window.addEventListener("resize", () => {
  setTimeout(() => {
    if (map) map.updateSize();
  }, 200);
});
latitudeInput.addEventListener("change", () => {
  focusMapFromCoordinateInputs();
  refreshWeatherFromCoordinates();
});
longitudeInput.addEventListener("change", () => {
  focusMapFromCoordinateInputs();
  refreshWeatherFromCoordinates();
});
weatherProviderInput.addEventListener("change", () => {
  refreshWeatherFromCoordinates();
});

ensureMap();
renderRecords();
