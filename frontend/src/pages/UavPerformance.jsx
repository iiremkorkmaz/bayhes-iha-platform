import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  CloudSun,
  Compass,
  Crosshair,
  Gauge,
  MapPin,
  PlaneTakeoff,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Wind,
} from "lucide-react";
import { calculateTakeoffAnalysis } from "../utils/takeoffCalculations.js";
import {
  calculateWeatherConfidence,
  checkLocationDistrictMismatch,
  createEmptyWeather,
  fetchElevationByCoordinates,
  fetchWeatherByDistrict,
  getWeatherDataTypeLabel,
  normalizeCoordinate,
  validateCoordinate,
  WEATHER_DATA_TYPES,
} from "../services/weatherService.js";

const initialForm = {
  province: "",
  district: "",
  latitude: "",
  longitude: "",
  runwayHeadingDeg: "90",
  runwayDirection: "primary",
  runwayLength: "70",
  runwaySlopePercent: "0",
  surface: "Asfalt",
  massKg: "4.5",
  cgPercent: "",
  flapSetting: "Yok",
  batteryVoltage: "",
  batteryPercent: "",
};

const requiredWeatherFields = [
  "temperatureC",
  "humidityPercent",
  "pressureHpa",
  "windSpeedMs",
  "windDirectionDeg",
];

function parseNumber(value) {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function format(value, digits = 1) {
  return Number.isFinite(value)
    ? value.toLocaleString("tr-TR", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : "Hesaplanamadı";
}

function withUnit(value, unit, digits = 1) {
  return Number.isFinite(value) ? `${format(value, digits)} ${unit}` : "Hesaplanamadı";
}

function kmh(value) {
  return Number.isFinite(value) ? `${format(value * 3.6, 1)} km/h` : "Hesaplanamadı";
}

function formatMilestone(milestone) {
  return milestone
    ? `${format(milestone.time, 1)} s / ${format(milestone.distance, 1)} m / ${kmh(milestone.airspeed)}`
    : "Hesaplanamadı";
}

function Field({
  label,
  name,
  value,
  onChange,
  unit,
  type = "text",
  optional = false,
  ...props
}) {
  return (
    <label className="takeoff-field">
      <span>
        {label}
        {unit ? <small>{unit}</small> : optional ? <small>Opsiyonel</small> : null}
      </span>
      <input
        type={type}
        name={name}
        value={value}
        onChange={onChange}
        {...props}
      />
    </label>
  );
}

function SelectField({ label, name, value, onChange, children }) {
  return (
    <label className="takeoff-field">
      <span>{label}</span>
      <select name={name} value={value} onChange={onChange}>
        {children}
      </select>
    </label>
  );
}

function SectionCard({ icon: Icon, title, index, children, className = "" }) {
  return (
    <section className={`takeoff-card ${className}`}>
      <header className="takeoff-card__header">
        <span className="takeoff-card__index">{index}</span>
        <Icon size={20} />
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

function Metric({ label, value, helper, tone = "" }) {
  return (
    <article className={`takeoff-metric ${tone ? `takeoff-metric--${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {helper ? <small>{helper}</small> : null}
    </article>
  );
}

function EmptyResult() {
  return (
    <div className="takeoff-empty">
      Gerekli verileri girip kalkış analizini hesaplayın.
    </div>
  );
}

export default function UavPerformance() {
  const [form, setForm] = useState(initialForm);
  const [weather, setWeather] = useState(createEmptyWeather);
  const [weatherMessage, setWeatherMessage] = useState(
    "Meteoroloji değerlerini manuel girebilir veya canlı veriyi alabilirsiniz.",
  );
  const [coordinateMessage, setCoordinateMessage] = useState("");
  const [locationMismatch, setLocationMismatch] = useState(false);
  const [elevation, setElevation] = useState({
    value: null,
    status: "idle",
  });
  const [loadingWeather, setLoadingWeather] = useState(false);
  const [submitted, setSubmitted] = useState(null);

  const heading = parseNumber(form.runwayHeadingDeg);
  const reverseHeading = Number.isFinite(heading) ? (heading + 180) % 360 : null;
  const selectedHeading =
    form.runwayDirection === "reverse" ? reverseHeading : heading;

  const analysis = useMemo(() => {
    if (!submitted) return null;
    return calculateTakeoffAnalysis(
      submitted.input,
      submitted.weather,
      submitted.calculatedAt,
    );
  }, [submitted]);
  const weatherConfidence = useMemo(
    () => calculateWeatherConfidence(weather),
    [weather],
  );

  function handleChange(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setSubmitted(null);

    if (["province", "district", "latitude", "longitude"].includes(name)) {
      setLocationMismatch(false);
      setWeather((current) =>
        [
          WEATHER_DATA_TYPES.RUNWAY_MEASUREMENT,
          WEATHER_DATA_TYPES.MANUAL_ESTIMATE,
        ].includes(current.sourceType)
          ? current
          : createEmptyWeather(),
      );
      setWeatherMessage((current) =>
        [
          WEATHER_DATA_TYPES.RUNWAY_MEASUREMENT,
          WEATHER_DATA_TYPES.MANUAL_ESTIMATE,
        ].includes(weather.sourceType)
          ? current
          : "Konum değişti. Canlı meteoroloji verisini yeniden alın.",
      );
    }
    if (["latitude", "longitude"].includes(name)) {
      setElevation({ value: null, status: "idle" });
    }
  }

  function handleCoordinateBlur(event) {
    const normalized = normalizeCoordinate(event.target.value);
    if (normalized !== null) {
      setForm((current) => ({ ...current, [event.target.name]: String(normalized) }));
    }

    const latitude =
      event.target.name === "latitude" ? event.target.value : form.latitude;
    const longitude =
      event.target.name === "longitude" ? event.target.value : form.longitude;
    const validation = validateCoordinate(latitude, longitude);
    setCoordinateMessage(
      validation.valid || (!String(latitude).trim() && !String(longitude).trim())
        ? ""
        : validation.errors.join(" "),
    );
  }

  function handleWeatherChange(event) {
    const { name, value } = event.target;
    setSubmitted(null);
    setWeather((current) => ({
      ...current,
      [name]: value,
      source:
        current.sourceType === WEATHER_DATA_TYPES.RUNWAY_MEASUREMENT
          ? "Pist üstü manuel ölçüm"
          : "Manuel tahmini giriş",
      sourceType:
        current.sourceType === WEATHER_DATA_TYPES.RUNWAY_MEASUREMENT
          ? WEATHER_DATA_TYPES.RUNWAY_MEASUREMENT
          : WEATHER_DATA_TYPES.MANUAL_ESTIMATE,
      stationName: "",
      stationDistanceKm: null,
      observedAt: new Date().toISOString(),
    }));
    setWeatherMessage("Kullanıcı tarafından girilen meteoroloji verisi kullanılıyor.");
  }

  function handleWeatherTypeChange(event) {
    const sourceType = event.target.value;
    if (
      ![
        WEATHER_DATA_TYPES.RUNWAY_MEASUREMENT,
        WEATHER_DATA_TYPES.MANUAL_ESTIMATE,
      ].includes(sourceType)
    ) {
      return;
    }

    setSubmitted(null);
    setWeather({
      ...createEmptyWeather(),
      sourceType,
      source: getWeatherDataTypeLabel(sourceType),
    });
    setWeatherMessage(
      sourceType === WEATHER_DATA_TYPES.RUNWAY_MEASUREMENT
        ? "Pist üstü ölçüm değerlerini girin."
        : "Tahmini manuel meteoroloji değerlerini girin.",
    );
  }

  async function loadWeather() {
    const coordinates = validateCoordinate(form.latitude, form.longitude);
    if (!coordinates.valid) {
      setCoordinateMessage(coordinates.errors.join(" "));
      return;
    }
    if (!form.province.trim() || !form.district.trim()) {
      setCoordinateMessage("Canlı veri için il ve ilçe girilmelidir.");
      return;
    }

    const normalizedLocation = {
      latitude: String(coordinates.latitude),
      longitude: String(coordinates.longitude),
    };
    setForm((current) => ({ ...current, ...normalizedLocation }));
    setSubmitted(null);
    setCoordinateMessage("");
    setLoadingWeather(true);
    setElevation({ value: null, status: "loading" });

    const [weatherResult, elevationResult, mismatchResult] = await Promise.allSettled([
      fetchWeatherByDistrict(
        form.province,
        form.district,
        coordinates.latitude,
        coordinates.longitude,
      ),
      fetchElevationByCoordinates(coordinates.latitude, coordinates.longitude),
      checkLocationDistrictMismatch(
        form.province,
        form.district,
        coordinates.latitude,
        coordinates.longitude,
      ),
    ]);

    if (weatherResult.status === "fulfilled") {
      setWeather(weatherResult.value);
      setWeatherMessage("Open-Meteo model tahmini alındı.");
    } else {
      setWeather((current) =>
        [
          WEATHER_DATA_TYPES.RUNWAY_MEASUREMENT,
          WEATHER_DATA_TYPES.MANUAL_ESTIMATE,
        ].includes(current.sourceType)
          ? current
          : createEmptyWeather(),
      );
      setWeatherMessage(
        "Canlı meteoroloji verisi alınamadı. Meteoroloji değerlerini manuel girebilirsiniz.",
      );
    }

    if (elevationResult.status === "fulfilled") {
      setElevation({ value: elevationResult.value, status: "ready" });
    } else {
      setElevation({ value: null, status: "error" });
    }

    setLocationMismatch(
      mismatchResult.status === "fulfilled" && mismatchResult.value.mismatch,
    );
    setLoadingWeather(false);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!form.province.trim() || !form.district.trim()) {
      setCoordinateMessage("Meteoroloji konumu için il ve ilçe girilmelidir.");
      return;
    }
    const coordinates = validateCoordinate(form.latitude, form.longitude);
    if (!coordinates.valid) {
      setCoordinateMessage(coordinates.errors.join(" "));
      return;
    }

    const massKg = parseNumber(form.massKg);
    const runwayLength = parseNumber(form.runwayLength);
    const runwaySlopePercent = parseNumber(form.runwaySlopePercent);
    if (
      !Number.isFinite(massKg) ||
      massKg <= 0 ||
      !Number.isFinite(runwayLength) ||
      runwayLength <= 0 ||
      !Number.isFinite(selectedHeading) ||
      !Number.isFinite(runwaySlopePercent)
    ) {
      setWeatherMessage("Pist ve İHA alanlarındaki zorunlu değerleri kontrol edin.");
      return;
    }

    const parsedWeather = Object.fromEntries(
      requiredWeatherFields.map((key) => [key, parseNumber(weather[key])]),
    );
    if (Object.values(parsedWeather).some((value) => !Number.isFinite(value))) {
      setWeatherMessage(
        "Meteoroloji verileri eksik. Canlı veri alın veya manuel değer girin.",
      );
      return;
    }

    const calculatedAt = Date.now();
    const confidence = calculateWeatherConfidence(weather, calculatedAt);
    let mismatchForAnalysis = locationMismatch;
    try {
      const mismatchResult = await checkLocationDistrictMismatch(
        form.province,
        form.district,
        coordinates.latitude,
        coordinates.longitude,
      );
      if (mismatchResult.checked) {
        mismatchForAnalysis = mismatchResult.mismatch;
        setLocationMismatch(mismatchResult.mismatch);
      }
    } catch {
      // Konum kontrolü başarısızsa mevcut doğrulama durumu korunur.
    }
    setSubmitted({
      calculatedAt,
      locationMismatch: mismatchForAnalysis,
      location: {
        province: form.province.trim(),
        district: form.district.trim(),
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
      },
      input: {
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        elevationM: elevation.value,
        runwayHeadingDeg: selectedHeading,
        runwayLength,
        runwaySlopePercent,
        surface: form.surface,
        massKg,
        cgPercent: parseNumber(form.cgPercent),
        flapSetting: form.flapSetting,
        batteryVoltage: parseNumber(form.batteryVoltage),
        batteryPercent: parseNumber(form.batteryPercent),
      },
      weather: {
        ...weather,
        ...parsedWeather,
        gustSpeedMs: parseNumber(weather.gustSpeedMs),
        confidenceCode: confidence.code,
        confidenceLevel: confidence.level,
      },
    });
  }

  const weatherIsOld =
    analysis && Number.isFinite(analysis.weatherAgeMinutes)
      ? analysis.weatherAgeMinutes > 15
      : false;
  const modelPointIsFar =
    Number.isFinite(weather.stationDistanceKm) && weather.stationDistanceKm > 10;
  const windLabel =
    analysis?.wind.headwind >= 0 ? "Karşı rüzgar" : "Kuyruk rüzgarı";
  const cgValue = submitted?.input.cgPercent;
  const batteryWasEntered = Number.isFinite(submitted?.input.batteryPercent);
  const submittedWeatherIsUnverifiedManual =
    submitted?.weather.sourceType === WEATHER_DATA_TYPES.MANUAL_ESTIMATE;

  return (
    <form className="takeoff-assistant" onSubmit={handleSubmit}>
      <div className="takeoff-intro">
        <p>
          İHA için pist, hava, ağırlık ve konfigürasyon verilerini birlikte
          değerlendiren kalkış karar desteği.
        </p>
        <div className="takeoff-disclaimer">
          <AlertTriangle size={20} />
          <strong>Bu sistem uçuş kontrol komutu üretmez.</strong>
          <span>
            Hesaplanan değerler pilot/yazılım için tahmini kalkış destek
            tavsiyesidir. Nihai kontrol ArduPilot ve pilotta kalır.
          </span>
        </div>
      </div>

      <div className="takeoff-layout">
        <div className="takeoff-inputs">
          <SectionCard index="01" icon={MapPin} title="Kalkış Konumu">
            <div className="takeoff-form-grid">
              <Field
                label="İl"
                name="province"
                value={form.province}
                onChange={handleChange}
                placeholder="Mersin"
              />
              <Field
                label="İlçe"
                name="district"
                value={form.district}
                onChange={handleChange}
                placeholder="Mut"
              />
              <Field
                label="Enlem"
                name="latitude"
                value={form.latitude}
                onChange={handleChange}
                onBlur={handleCoordinateBlur}
                inputMode="decimal"
                placeholder="36,6439"
              />
              <Field
                label="Boylam"
                name="longitude"
                value={form.longitude}
                onChange={handleChange}
                onBlur={handleCoordinateBlur}
                inputMode="decimal"
                placeholder="33,4384"
              />
            </div>
            <div className="takeoff-location-summary">
              <span>
                <b>Meteoroloji konumu:</b>{" "}
                {form.province.trim() || form.district.trim()
                  ? `${form.province.trim() || "-"} / ${form.district.trim() || "-"}`
                  : "-"}
              </span>
              <span>
                <b>Kalkış noktası:</b>{" "}
                {form.latitude.trim() && form.longitude.trim()
                  ? `${form.latitude.trim()}, ${form.longitude.trim()}`
                  : "-"}
              </span>
            </div>
            {coordinateMessage ? (
              <p className="takeoff-warning">{coordinateMessage}</p>
            ) : null}
            {locationMismatch ? (
              <p className="takeoff-warning">
                Girilen koordinat seçilen il/ilçe ile uyumlu görünmüyor.
              </p>
            ) : null}
            <div className="takeoff-status-line">
              <strong>Rakım:</strong>
              {elevation.status === "ready"
                ? ` ${format(elevation.value, 0)} m (Open-Meteo/Copernicus DEM)`
                : elevation.status === "loading"
                  ? " Alınıyor..."
                  : elevation.status === "error"
                    ? " Rakım alınamadı, manuel kontrol gerekli."
                    : " Koordinat doğrulamasıyla otomatik alınır."}
            </div>
          </SectionCard>

          <SectionCard index="02" icon={CloudSun} title="Meteoroloji Verisi">
            <div className="weather-toolbar">
              <button
                className="takeoff-secondary"
                type="button"
                onClick={loadWeather}
                disabled={loadingWeather}
              >
                <RefreshCw size={16} className={loadingWeather ? "is-spinning" : ""} />
                {loadingWeather
                  ? "Canlı veri alınıyor"
                  : "Canlı meteoroloji verisini al"}
              </button>
              <span>{weatherMessage}</span>
            </div>
            <div className="takeoff-form-grid">
              <SelectField
                label="Meteoroloji veri tipi"
                name="weatherDataType"
                value={weather.sourceType}
                onChange={handleWeatherTypeChange}
              >
                <option
                  value={WEATHER_DATA_TYPES.MGM_LIVE}
                  disabled={weather.sourceType !== WEATHER_DATA_TYPES.MGM_LIVE}
                >
                  MGM canlı istasyon verisi
                </option>
                <option
                  value={WEATHER_DATA_TYPES.OPEN_METEO}
                  disabled={weather.sourceType !== WEATHER_DATA_TYPES.OPEN_METEO}
                >
                  Open-Meteo model tahmini
                </option>
                <option value={WEATHER_DATA_TYPES.RUNWAY_MEASUREMENT}>
                  Pist üstü manuel ölçüm
                </option>
                <option value={WEATHER_DATA_TYPES.MANUAL_ESTIMATE}>
                  Manuel tahmini giriş
                </option>
              </SelectField>
              <Field
                label="Sıcaklık"
                name="temperatureC"
                value={weather.temperatureC}
                onChange={handleWeatherChange}
                unit="°C"
                inputMode="decimal"
              />
              <Field
                label="Nem"
                name="humidityPercent"
                value={weather.humidityPercent}
                onChange={handleWeatherChange}
                unit="%"
                inputMode="decimal"
              />
              <Field
                label="QNH / basınç"
                name="pressureHpa"
                value={weather.pressureHpa}
                onChange={handleWeatherChange}
                unit="hPa"
                inputMode="decimal"
              />
              <Field
                label="Rüzgar hızı"
                name="windSpeedMs"
                value={weather.windSpeedMs}
                onChange={handleWeatherChange}
                unit="m/s"
                inputMode="decimal"
              />
              <Field
                label="Rüzgar yönü"
                name="windDirectionDeg"
                value={weather.windDirectionDeg}
                onChange={handleWeatherChange}
                unit="°"
                inputMode="decimal"
              />
              <Field
                label="Ani rüzgar"
                name="gustSpeedMs"
                value={weather.gustSpeedMs}
                onChange={handleWeatherChange}
                unit="m/s"
                inputMode="decimal"
                optional
              />
            </div>
            <div className="weather-meta">
              <span>
                <b>Veri tipi:</b> {getWeatherDataTypeLabel(weather.sourceType)}
              </span>
              <span>
                <b>Veri kaynağı:</b> {weather.source}
              </span>
              <span>
                <b>Veri güveni:</b>{" "}
                <strong
                  className={`weather-confidence weather-confidence--${weatherConfidence.code}`}
                >
                  {weatherConfidence.level}
                </strong>
              </span>
              {weather.stationName ? (
                <span>
                  <b>Veri noktası:</b> {weather.stationName}
                </span>
              ) : null}
              <span>
                <b>İstasyon/model mesafesi:</b>{" "}
                {Number.isFinite(weather.stationDistanceKm)
                  ? `${format(weather.stationDistanceKm, 1)} km`
                  : "Belirtilmedi"}
              </span>
              <span>
                <b>Son güncelleme zamanı:</b>{" "}
                {weather.observedAt
                  ? new Date(weather.observedAt).toLocaleString("tr-TR")
                  : "Belirtilmedi"}
              </span>
            </div>
            <p className="takeoff-weather-disclaimer">
              Rüzgâr verisi en yakın istasyon veya seçilen veri kaynağına göre
              alınır. Pist üzerindeki gerçek rüzgâr; bina, arazi, ağaç, tepe ve
              lokal türbülans nedeniyle farklı olabilir.
            </p>
            {weather.sourceType === WEATHER_DATA_TYPES.MANUAL_ESTIMATE ? (
              <p className="takeoff-info">
                Meteoroloji verisi kullanıcı girişine dayalıdır; pist üstü ölçüm
                doğrulaması önerilir.
              </p>
            ) : null}
            {weatherIsOld ? (
              <p className="takeoff-warning">
                Meteoroloji verisi güncel olmayabilir.
              </p>
            ) : null}
            {modelPointIsFar ? (
              <p className="takeoff-warning">
                Meteoroloji model noktası pistten uzak. Pist üzerindeki gerçek
                rüzgar farklı olabilir.
              </p>
            ) : null}
          </SectionCard>

          <SectionCard index="03" icon={Compass} title="Pist Bilgileri">
            <div className="takeoff-form-grid">
              <Field
                label="Pist yönü"
                name="runwayHeadingDeg"
                value={form.runwayHeadingDeg}
                onChange={handleChange}
                unit="°"
                inputMode="decimal"
              />
              <SelectField
                label="Kullanılacak yön"
                name="runwayDirection"
                value={form.runwayDirection}
                onChange={handleChange}
              >
                <option value="primary">
                  {Number.isFinite(heading)
                    ? `${String(heading).padStart(3, "0")}°`
                    : "Ana yön"}
                </option>
                <option value="reverse">
                  {Number.isFinite(reverseHeading)
                    ? `${String(reverseHeading).padStart(3, "0")}° (ters pist)`
                    : "Ters yön"}
                </option>
              </SelectField>
              <Field
                label="Pist uzunluğu"
                name="runwayLength"
                value={form.runwayLength}
                onChange={handleChange}
                unit="m"
                inputMode="decimal"
              />
              <Field
                label="Pist eğimi"
                name="runwaySlopePercent"
                value={form.runwaySlopePercent}
                onChange={handleChange}
                unit="%"
                inputMode="decimal"
              />
              <SelectField
                label="Pist zemini"
                name="surface"
                value={form.surface}
                onChange={handleChange}
              >
                {["Asfalt", "Kısa çim", "Uzun çim", "Toprak", "Islak zemin"].map(
                  (surface) => (
                    <option key={surface}>{surface}</option>
                  ),
                )}
              </SelectField>
              <div className="takeoff-inline-note">
                Aktif kalkış yönü:
                <strong>
                  {Number.isFinite(selectedHeading)
                    ? `${String(selectedHeading).padStart(3, "0")}°`
                    : "-"}
                </strong>
              </div>
            </div>
          </SectionCard>

          <SectionCard index="04" icon={PlaneTakeoff} title="İHA Konfigürasyonu">
            <div className="takeoff-form-grid">
              <Field
                label="Toplam kalkış ağırlığı"
                name="massKg"
                value={form.massKg}
                onChange={handleChange}
                unit="kg"
                inputMode="decimal"
              />
              <Field
                label="CG konumu"
                name="cgPercent"
                value={form.cgPercent}
                onChange={handleChange}
                unit="% MAC"
                inputMode="decimal"
                optional
              />
              <SelectField
                label="Flap durumu"
                name="flapSetting"
                value={form.flapSetting}
                onChange={handleChange}
              >
                {["Yok", "5°", "10°", "15°"].map((flap) => (
                  <option key={flap}>{flap}</option>
                ))}
              </SelectField>
              <Field
                label="Batarya doluluğu"
                name="batteryPercent"
                value={form.batteryPercent}
                onChange={handleChange}
                unit="%"
                inputMode="decimal"
                optional
              />
              <Field
                label="Batarya voltajı"
                name="batteryVoltage"
                value={form.batteryVoltage}
                onChange={handleChange}
                unit="V"
                inputMode="decimal"
                optional
              />
            </div>
            <p className="takeoff-card__note">
              Mühendislik katsayıları Avionix İHA varsayılan konfigürasyonuna
              göre kullanılır.
            </p>
          </SectionCard>

          <button className="takeoff-calculate" type="submit">
            <Gauge size={20} /> Kalkış analizini hesapla
          </button>
        </div>

        <div className="takeoff-results">
          <SectionCard index="05" icon={Wind} title="Rüzgar Analizi">
            {analysis ? (
              <div className="takeoff-metric-grid">
                <Metric
                  label={windLabel}
                  value={withUnit(Math.abs(analysis.wind.headwind), "m/s", 2)}
                  helper={kmh(Math.abs(analysis.wind.headwind))}
                  tone={analysis.wind.headwind < 0 ? "risk" : "success"}
                />
                <Metric
                  label="Yan rüzgar"
                  value={withUnit(Math.abs(analysis.wind.crosswind), "m/s", 2)}
                  helper={`${analysis.controls.direction} · ${kmh(Math.abs(analysis.wind.crosswind))}`}
                  tone={Math.abs(analysis.wind.crosswind) > 6 ? "risk" : "warning"}
                />
                <Metric
                  label="Bağıl rüzgar açısı"
                  value={withUnit(analysis.wind.relativeAngle, "°", 1)}
                />
                <Metric
                  label="Gerekli yer hızı"
                  value={kmh(analysis.requiredGroundSpeed)}
                  helper={withUnit(analysis.requiredGroundSpeed, "m/s", 2)}
                />
              </div>
            ) : (
              <EmptyResult />
            )}
          </SectionCard>

          <SectionCard index="06" icon={Gauge} title="Kalkış Performansı">
            {analysis ? (
              <>
                <div className="takeoff-metric-grid">
                  <Metric
                    label="Stall hızı"
                    value={kmh(analysis.stallSpeed)}
                    helper={withUnit(analysis.stallSpeed, "m/s", 2)}
                  />
                  <Metric
                    label="Rotate hızı"
                    value={kmh(analysis.rotateSpeed)}
                    helper={withUnit(analysis.rotateSpeed, "m/s", 2)}
                  />
                  <Metric
                    label="Teker kesme hızı"
                    value={kmh(analysis.liftoffSpeed)}
                    helper={withUnit(analysis.liftoffSpeed, "m/s", 2)}
                  />
                  <Metric
                    label="Güvenli kalkış hızı"
                    value={kmh(analysis.takeoffSpeed)}
                    helper={withUnit(analysis.takeoffSpeed, "m/s", 2)}
                  />
                  <Metric
                    label="Gerekli pist"
                    value={withUnit(analysis.noWindGroundRoll.distance, "m", 1)}
                  />
                  <Metric
                    label="Rüzgar etkili gerekli pist"
                    value={withUnit(analysis.groundRoll.distance, "m", 1)}
                    tone={analysis.runwayMargin >= 0 ? "success" : "danger"}
                  />
                  <Metric
                    label="Pist güvenlik payı"
                    value={withUnit(analysis.runwayMargin, "m", 1)}
                    tone={analysis.runwayMargin >= 0 ? "success" : "danger"}
                  />
                  <Metric
                    label="Pist kullanım oranı"
                    value={
                      Number.isFinite(analysis.runwayUsage)
                        ? `%${format(analysis.runwayUsage, 0)}`
                        : "Hesaplanamadı"
                    }
                    tone={analysis.runwayUsage <= 80 ? "success" : "warning"}
                  />
                  <Metric
                    label="T/W oranı"
                    value={format(analysis.thrustWeightRatio, 2)}
                  />
                  <Metric
                    label="Kalkış ivmesi"
                    value={withUnit(analysis.groundRoll.acceleration, "m/s²", 2)}
                  />
                  <Metric
                    label="Yoğunluk irtifası"
                    value={withUnit(analysis.densityAltitudeM, "m", 0)}
                  />
                  <Metric
                    label="Hava yoğunluğu"
                    value={withUnit(analysis.density, "kg/m³", 3)}
                  />
                  <Metric
                    label="Performans kaybı"
                    value={
                      Number.isFinite(analysis.performanceLossPercent)
                        ? `%${format(analysis.performanceLossPercent, 1)}`
                        : "Hesaplanamadı"
                    }
                  />
                  <Metric
                    label="Tahmini tırmanış"
                    value={withUnit(analysis.climb.rateOfClimb, "m/s", 2)}
                    helper={`${format(analysis.climb.climbAngleDeg, 1)}° · ${analysis.climb.safety}`}
                    tone={
                      analysis.climb.safety === "Yeterli" ? "success" : "warning"
                    }
                  />
                </div>
                {!Number.isFinite(submitted.input.elevationM) ? (
                  <p className="takeoff-warning">
                    Rakım alınamadığı için yoğunluk irtifası hesaplanamadı.
                  </p>
                ) : null}
                {!batteryWasEntered ? (
                  <p className="takeoff-info">
                    Batarya doluluğu girilmedi; batarya kaynaklı itki kaybı
                    değerlendirilmedi.
                  </p>
                ) : null}
              </>
            ) : (
              <EmptyResult />
            )}
          </SectionCard>

          <SectionCard
            index="07"
            icon={PlaneTakeoff}
            title="Teker Kesme / Rotate Analizi"
          >
            {analysis ? (
              <div className="takeoff-metric-grid takeoff-metric-grid--single">
                <Metric
                  label="Rotate"
                  value={formatMilestone(analysis.rotateAndLiftoff.rotate)}
                />
                <Metric
                  label="Teker kesme"
                  value={formatMilestone(analysis.rotateAndLiftoff.liftoff)}
                />
                <Metric
                  label="Güvenli kalkış hızına ulaşma"
                  value={formatMilestone(analysis.rotateAndLiftoff.safe)}
                />
              </div>
            ) : (
              <EmptyResult />
            )}
          </SectionCard>

          <SectionCard index="08" icon={ShieldCheck} title="Abort Analizi">
            {analysis ? (
              <div className="takeoff-metric-grid">
                <Metric
                  label="Abort noktası"
                  value={withUnit(analysis.abort.distance, "m", 1)}
                />
                <Metric
                  label="Pistin %50 noktasındaki hız"
                  value={kmh(analysis.abort.speed)}
                  helper={withUnit(analysis.abort.speed, "m/s", 2)}
                />
                <Metric
                  label="Gerekli minimum hız"
                  value={kmh(analysis.abort.minimumSpeed)}
                />
                <Metric
                  label="Tahmini durma mesafesi"
                  value={withUnit(analysis.abort.stopDistance, "m", 1)}
                />
                <Metric
                  label="Accelerate-stop mesafesi"
                  value={withUnit(analysis.abort.accelerateStopDistance, "m", 1)}
                  tone={analysis.abort.stopsWithinRunway ? "success" : "danger"}
                />
                <Metric
                  label="Abort kararı"
                  value={analysis.abort.decision}
                  tone={analysis.abort.canContinue ? "success" : "danger"}
                />
              </div>
            ) : (
              <EmptyResult />
            )}
          </SectionCard>

          <SectionCard index="09" icon={Crosshair} title="CG Güvenliği">
            {analysis ? (
              <div className="takeoff-metric-grid">
                <Metric
                  label="CG"
                  value={
                    Number.isFinite(cgValue)
                      ? `%${format(cgValue, 1)} MAC`
                      : "Girilmedi"
                  }
                />
                <Metric
                  label="Durum"
                  value={analysis.cg.status}
                  helper={analysis.cg.detail}
                  tone={
                    analysis.cg.safe === true
                      ? "success"
                      : analysis.cg.safe === false
                        ? "danger"
                        : ""
                  }
                />
              </div>
            ) : (
              <EmptyResult />
            )}
          </SectionCard>

          <SectionCard
            index="10"
            icon={SlidersHorizontal}
            title="Aileron-Rudder Tavsiyesi"
          >
            {analysis ? (
              <>
                <div className="takeoff-metric-grid">
                  <Metric
                    label="Yan rüzgar"
                    value={`${withUnit(Math.abs(analysis.wind.crosswind), "m/s", 2)} ${analysis.controls.direction}`}
                  />
                  <Metric
                    label="Aileron tavsiyesi"
                    value={analysis.controls.aileronText}
                  />
                  <Metric
                    label="Rudder tavsiyesi"
                    value={analysis.controls.rudderText}
                  />
                </div>
                <p className="control-explanation">
                  {analysis.controls.explanation}
                </p>
              </>
            ) : (
              <EmptyResult />
            )}
          </SectionCard>

          <SectionCard
            index="11"
            icon={PlaneTakeoff}
            title="Genel Karar"
            className={
              analysis
                ? `decision-card decision-card--${analysis.risk.tone}`
                : "decision-card"
            }
          >
            {analysis ? (
              <div className="decision-card__content">
                <span>
                  Risk seviyesi: {analysis.risk.level} · Puan:{" "}
                  {format(analysis.risk.score, 0)}
                </span>
                <strong>{analysis.risk.decision}</strong>
                <p>Sınırlayıcı faktör: {analysis.risk.limitingFactor}</p>
                <p>
                  Meteoroloji güveni: {submitted.weather.confidenceLevel} ·{" "}
                  {getWeatherDataTypeLabel(submitted.weather.sourceType)}
                </p>
                {submittedWeatherIsUnverifiedManual ? (
                  <p className="decision-note">
                    Meteoroloji verisi kullanıcı girişine dayalıdır; pist üstü
                    ölçüm doğrulaması önerilir.
                  </p>
                ) : null}
                {submitted.locationMismatch ? (
                  <p className="decision-note decision-note--warning">
                    Konum uyumsuzluğu: Meteoroloji konumu ile kalkış koordinatı
                    farklı bölgeleri işaret ediyor olabilir.
                  </p>
                ) : null}
              </div>
            ) : (
              <EmptyResult />
            )}
          </SectionCard>
        </div>
      </div>
    </form>
  );
}
