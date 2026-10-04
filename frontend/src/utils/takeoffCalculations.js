export const AIRCRAFT_CONFIG = Object.freeze({
  wingArea: 0.30306,
  CLmax: 1.3,
  takeoffCL: 0.8,
  takeoffCD: 0.08,
  staticThrust: 22.58,
  safeCgMin: 25,
  safeCgMax: 33,
  maxAileronDeg: 15,
  maxRudderDeg: 12,
  rudderK: 0.3,
  aileronK: 0.35,
  propWashEquivalentSpeed: 30,
});

export const PHYSICS = Object.freeze({
  gravity: 9.81,
  seaLevelDensity: 1.225,
  dt: 0.01,
  rotateSpeedFactor: 1.15,
  liftoffSpeedFactor: 1.2,
  takeoffSpeedFactor: 1.3,
});

export const SURFACE_FRICTION = Object.freeze({
  Asfalt: 0.04,
  "Kısa çim": 0.06,
  "Uzun çim": 0.1,
  Toprak: 0.08,
  "Islak zemin": 0.09,
});

export const BRAKE_FRICTION = Object.freeze({
  Asfalt: 0.35,
  "Kısa çim": 0.25,
  "Uzun çim": 0.18,
  Toprak: 0.22,
  "Islak zemin": 0.18,
});

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;
const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

export function normalize180(degrees) {
  return ((degrees + 180) % 360 + 360) % 360 - 180;
}

export function calculateStallSpeed({ massKg, density, wingArea, clMax }) {
  return Math.sqrt((2 * massKg * PHYSICS.gravity) / (density * wingArea * clMax));
}

export function calculateTakeoffSpeed(stallSpeed) {
  return stallSpeed * PHYSICS.takeoffSpeedFactor;
}

export function calculateSpeedTargets(stallSpeed) {
  return {
    rotateSpeed: stallSpeed * PHYSICS.rotateSpeedFactor,
    liftoffSpeed: stallSpeed * PHYSICS.liftoffSpeedFactor,
    safeTakeoffSpeed: calculateTakeoffSpeed(stallSpeed),
  };
}

export function calculateRequiredGroundSpeed(airspeed, headwind) {
  return headwind >= 0
    ? Math.max(airspeed - headwind, airspeed * 0.45)
    : airspeed + Math.abs(headwind);
}

export function calculateWindComponents({ windDirectionDeg, windSpeedMs, runwayHeadingDeg }) {
  const relativeAngle = normalize180(windDirectionDeg - runwayHeadingDeg);
  const angleRadians = toRadians(relativeAngle);
  return {
    relativeAngle,
    headwind: windSpeedMs * Math.cos(angleRadians),
    crosswind: windSpeedMs * Math.sin(angleRadians),
  };
}

export function calculateDensityAltitude({
  temperatureC,
  pressureHpa,
  humidityPercent,
  elevationM,
}) {
  const temperatureK = temperatureC + 273.15;
  const saturationPressure =
    6.112 * Math.exp((17.67 * temperatureC) / (temperatureC + 243.5));
  const vaporPressure = saturationPressure * clamp(humidityPercent / 100, 0, 1);
  const dryPressurePa = (pressureHpa - vaporPressure) * 100;
  const vaporPressurePa = vaporPressure * 100;
  const density =
    dryPressurePa / (287.05 * temperatureK) +
    vaporPressurePa / (461.495 * temperatureK);
  const performanceLossPercent = Math.max(
    0,
    (1 - density / PHYSICS.seaLevelDensity) * 100,
  );

  if (!isFiniteNumber(elevationM)) {
    return {
      density,
      densityAltitudeM: Number.NaN,
      performanceLossPercent,
    };
  }

  const pressureAltitudeM = elevationM + (1013.25 - pressureHpa) * 8.3;
  const isaTemperature = 15 - 0.0065 * pressureAltitudeM;
  return {
    density,
    densityAltitudeM:
      pressureAltitudeM + 36.6 * (temperatureC - isaTemperature),
    performanceLossPercent,
  };
}

export function calculateGroundRoll({
  massKg,
  density,
  wingArea,
  clTakeoff,
  cdTakeoff,
  staticThrust,
  batteryPercent,
  runwaySlopePercent,
  surface,
  targetGroundSpeed,
  runwayLength,
  propWashEquivalentSpeed,
  speedMilestones = {},
}) {
  const weight = massKg * PHYSICS.gravity;
  const mu = SURFACE_FRICTION[surface] ?? SURFACE_FRICTION.Asfalt;
  const slopeAngle = Math.atan(runwaySlopePercent / 100);
  const batteryFactor = isFiniteNumber(batteryPercent)
    ? clamp(0.72 + (batteryPercent / 100) * 0.28, 0.72, 1)
    : 1;
  const availableStaticThrust = staticThrust * batteryFactor;
  const abortDistance = runwayLength * 0.5;
  const milestones = Object.fromEntries(
    Object.keys(speedMilestones).map((key) => [key, null]),
  );
  let speed = 0;
  let distance = 0;
  let elapsed = 0;
  let abortSpeed = null;
  let lastAcceleration = 0;
  let liftoffThrust = availableStaticThrust;

  while (speed < targetGroundSpeed && elapsed < 60 && distance < runwayLength * 3) {
    const dynamicPressure = 0.5 * density * speed ** 2;
    const drag = dynamicPressure * wingArea * cdTakeoff;
    const lift = dynamicPressure * wingArea * clTakeoff;
    const normalForce = Math.max(weight - lift, 0);
    const friction = mu * normalForce;
    const thrustEffective =
      availableStaticThrust *
      clamp(1 - speed / propWashEquivalentSpeed, 0.45, 1);
    const slopeForce = weight * Math.sin(slopeAngle);
    const acceleration =
      (thrustEffective - drag - friction - slopeForce) / massKg;

    if (acceleration <= 0.01 && speed < targetGroundSpeed * 0.95) {
      return {
        possible: false,
        distance: Number.POSITIVE_INFINITY,
        time: elapsed,
        abortSpeed: abortSpeed ?? speed,
        acceleration,
        liftoffThrust: thrustEffective,
        milestones,
      };
    }

    lastAcceleration = acceleration;
    speed = Math.max(0, speed + acceleration * PHYSICS.dt);
    distance += speed * PHYSICS.dt;
    elapsed += PHYSICS.dt;
    liftoffThrust = thrustEffective;

    Object.entries(speedMilestones).forEach(([key, milestoneSpeed]) => {
      if (milestones[key] === null && speed >= milestoneSpeed) {
        milestones[key] = {
          time: elapsed,
          distance,
          groundSpeed: speed,
        };
      }
    });

    if (abortSpeed === null && distance >= abortDistance) {
      abortSpeed = speed;
    }
  }

  return {
    possible: speed >= targetGroundSpeed,
    distance,
    time: elapsed,
    abortSpeed: abortSpeed ?? speed,
    acceleration: lastAcceleration,
    liftoffThrust,
    milestones,
  };
}

export function calculateRotateAndLiftoff({
  groundRoll,
  rotateSpeed,
  liftoffSpeed,
  safeTakeoffSpeed,
}) {
  const withAirspeed = (milestone, airspeed) =>
    milestone ? { ...milestone, airspeed } : null;
  return {
    rotate: withAirspeed(groundRoll.milestones.rotate, rotateSpeed),
    liftoff: withAirspeed(groundRoll.milestones.liftoff, liftoffSpeed),
    safe: withAirspeed(groundRoll.milestones.safe, safeTakeoffSpeed),
  };
}

export function calculateStopDistance({ speedMs, surface }) {
  const brakeMu = BRAKE_FRICTION[surface] ?? BRAKE_FRICTION.Asfalt;
  const brakeDeceleration = PHYSICS.gravity * brakeMu;
  return {
    brakeMu,
    brakeDeceleration,
    distance: speedMs ** 2 / (2 * brakeDeceleration),
  };
}

export function calculateAbortPoint({
  runwayLength,
  abortSpeed,
  safeTakeoffSpeed,
  surface,
}) {
  const minimumAbortSpeed = safeTakeoffSpeed * 0.7;
  const speedIsEnough = abortSpeed >= minimumAbortSpeed;
  const stop = calculateStopDistance({ speedMs: abortSpeed, surface });
  const accelerateStopDistance = runwayLength * 0.5 + stop.distance;
  const stopsWithinRunway = accelerateStopDistance <= runwayLength;
  let decision = "Devam edilebilir";
  if (!speedIsEnough) {
    decision = "ABORT: Pistin yarısında yeterli hız yok";
  } else if (!stopsWithinRunway) {
    decision = "ABORT RİSKLİ: Durma mesafesi pist içinde kalmıyor";
  }

  return {
    distance: runwayLength * 0.5,
    speed: abortSpeed,
    minimumSpeed: minimumAbortSpeed,
    speedIsEnough,
    stopDistance: stop.distance,
    accelerateStopDistance,
    stopsWithinRunway,
    canContinue: speedIsEnough && stopsWithinRunway,
    decision,
  };
}

export function calculateClimbPerformance({
  massKg,
  density,
  wingArea,
  cdTakeoff,
  trueAirspeed,
  thrust,
}) {
  const weight = massKg * PHYSICS.gravity;
  const drag = 0.5 * density * trueAirspeed ** 2 * wingArea * cdTakeoff;
  const excessThrust = thrust - drag;
  const climbAngleRad = Math.asin(clamp(excessThrust / weight, -0.99, 0.99));
  const climbAngleDeg = toDegrees(climbAngleRad);
  const rateOfClimb = Math.max(0, trueAirspeed * Math.sin(climbAngleRad));
  const safety =
    rateOfClimb >= 2 ? "Yeterli" : rateOfClimb >= 1 ? "Sınırda" : "Yetersiz";
  return { drag, excessThrust, climbAngleDeg, rateOfClimb, safety };
}

export function calculateCGStatus({
  cgPercent,
  safeMinimum = AIRCRAFT_CONFIG.safeCgMin,
  safeMaximum = AIRCRAFT_CONFIG.safeCgMax,
}) {
  if (!isFiniteNumber(cgPercent)) {
    return {
      evaluated: false,
      safe: null,
      status: "Değerlendirilmedi",
      detail: "CG girilmedi, CG riski değerlendirilmedi.",
    };
  }
  if (cgPercent < safeMinimum) {
    return {
      evaluated: true,
      safe: false,
      status: "Burun ağır",
      detail: `Güvenli aralık %${safeMinimum} - %${safeMaximum} MAC`,
    };
  }
  if (cgPercent > safeMaximum) {
    return {
      evaluated: true,
      safe: false,
      status: "Kuyruk ağır",
      detail: "Stall ve toparlanma riski artar.",
    };
  }
  return {
    evaluated: true,
    safe: true,
    status: "Güvenli",
    detail: `Güvenli aralık %${safeMinimum} - %${safeMaximum} MAC`,
  };
}

export function calculateControlAdvice({
  crosswind,
  takeoffSpeed,
  rudderK = AIRCRAFT_CONFIG.rudderK,
  aileronK = AIRCRAFT_CONFIG.aileronK,
  maxRudderDeg = AIRCRAFT_CONFIG.maxRudderDeg,
  maxAileronDeg = AIRCRAFT_CONFIG.maxAileronDeg,
}) {
  const crosswindAbs = Math.abs(crosswind);
  if (crosswindAbs < 0.3) {
    return {
      direction: "ihmal edilebilir",
      aileronDeg: 0,
      rudderDeg: 0,
      aileronText: "Merkez",
      rudderText: "Merkez",
      explanation: "Yan rüzgar çok düşük. Kumandaları merkezde tutma tavsiyesi.",
    };
  }

  const betaDeg = toDegrees(Math.atan(crosswindAbs / takeoffSpeed));
  const rudderDeg = clamp(rudderK * betaDeg, 0, maxRudderDeg);
  const aileronDeg = clamp(aileronK * betaDeg, 0, maxAileronDeg);
  const fromRight = crosswind > 0;
  return {
    direction: fromRight ? "sağdan" : "soldan",
    aileronDeg,
    rudderDeg,
    aileronText: `${fromRight ? "Sağa" : "Sola"} ${aileronDeg.toFixed(1)}°`,
    rudderText: `${fromRight ? "Sola" : "Sağa"} ${rudderDeg.toFixed(1)}°`,
    explanation: fromRight
      ? "Rüzgar sağdan geliyor. Sağ kanadı rüzgara bastırmak için sağ aileron, pist merkez hattını korumak için sol rudder önerilir."
      : "Rüzgar soldan geliyor. Sol kanadı rüzgara bastırmak için sol aileron, pist merkez hattını korumak için sağ rudder önerilir.",
  };
}

export function calculateRiskLevel({
  runwayMargin,
  runwayUsage,
  headwind,
  crosswind,
  weatherAgeMinutes,
  weatherSourceType,
  weatherConfidence,
  stationDistanceKm,
  densityAltitudeM,
  elevationAvailable,
  cg,
  climbRate,
  abortSpeedSafe,
  accelerateStopFits,
  gustSpeedMs,
  windSpeedMs,
  batteryPercent,
  thrustPossible,
}) {
  const factors = [];
  let score = 0;
  const add = (points, label) => {
    score += points;
    factors.push({ points, label });
  };

  if (!thrustPossible) add(50, "Batarya / itki");
  if (runwayMargin < 0 || runwayUsage > 100) add(35, "Pist uzunluğu");
  else if (runwayUsage > 80) add(12, "Pist güvenlik payı");
  if (headwind < -2) {
    add(Math.min(25, 10 + Math.abs(headwind) * 3), "Kuyruk rüzgarı");
  }
  if (Math.abs(crosswind) > 6) add(20, "Yan rüzgar");
  else if (Math.abs(crosswind) > 3) add(10, "Yan rüzgar");
  if (isFiniteNumber(gustSpeedMs) && isFiniteNumber(windSpeedMs)) {
    const gustDifference = gustSpeedMs - windSpeedMs;
    if (gustDifference >= 5) add(15, "Ani rüzgar");
    else if (gustDifference >= 3) add(8, "Ani rüzgar");
  }
  if (isFiniteNumber(weatherAgeMinutes) && weatherAgeMinutes > 15) {
    add(8, "Eski meteoroloji verisi");
  }
  if (weatherSourceType === "open-meteo") add(3, "Model meteoroloji verisi");
  if (isFiniteNumber(stationDistanceKm) && stationDistanceKm > 10) {
    add(8, "Meteoroloji noktası mesafesi");
  }
  if (!elevationAvailable) add(8, "Rakım verisi");
  if (isFiniteNumber(densityAltitudeM) && densityAltitudeM > 1500) {
    add(15, "Yoğunluk irtifası");
  } else if (isFiniteNumber(densityAltitudeM) && densityAltitudeM > 800) {
    add(8, "Yoğunluk irtifası");
  }
  if (cg.evaluated && !cg.safe) add(30, "CG");
  if (climbRate < 1) add(25, "Tırmanış performansı");
  else if (climbRate < 2) add(10, "Tırmanış performansı");
  if (!abortSpeedSafe) add(30, "Abort noktası");
  if (!accelerateStopFits) add(25, "Abort mesafesi");
  if (isFiniteNumber(batteryPercent) && batteryPercent < 25) {
    add(25, "Batarya / itki");
  } else if (isFiniteNumber(batteryPercent) && batteryPercent < 40) {
    add(10, "Batarya seviyesi");
  }
  if (weatherConfidence === "low" && score < 15) {
    add(15 - score, "Meteoroloji veri güveni");
  }

  factors.sort((a, b) => b.points - a.points);
  if (score >= 60) {
    return {
      score,
      level: "Kalkış önerilmez",
      decision: "KALKIŞ ÖNERİLMEZ",
      tone: "danger",
      limitingFactor: factors[0]?.label,
    };
  }
  if (score >= 35) {
    return {
      score,
      level: "Yüksek",
      decision: "KALKIŞ RİSKLİ",
      tone: "risk",
      limitingFactor: factors[0]?.label,
    };
  }
  if (score >= 15) {
    return {
      score,
      level: "Orta",
      decision: "DİKKATLİ KALKIŞ",
      tone: "warning",
      limitingFactor: factors[0]?.label,
    };
  }
  return {
    score,
    level: "Düşük",
    decision: "KALKIŞ UYGUN",
    tone: "success",
    limitingFactor: factors[0]?.label ?? "Belirgin sınırlayıcı yok",
  };
}

export function calculateTakeoffAnalysis(input, weather, nowMs = Date.now()) {
  const densityData = calculateDensityAltitude({
    temperatureC: weather.temperatureC,
    pressureHpa: weather.pressureHpa,
    humidityPercent: weather.humidityPercent,
    elevationM: input.elevationM,
  });
  const stallSpeed = calculateStallSpeed({
    massKg: input.massKg,
    density: densityData.density,
    wingArea: AIRCRAFT_CONFIG.wingArea,
    clMax: AIRCRAFT_CONFIG.CLmax,
  });
  const speeds = calculateSpeedTargets(stallSpeed);
  const wind = calculateWindComponents({
    windDirectionDeg: weather.windDirectionDeg,
    windSpeedMs: weather.windSpeedMs,
    runwayHeadingDeg: input.runwayHeadingDeg,
  });
  const milestoneGroundSpeeds = {
    rotate: calculateRequiredGroundSpeed(speeds.rotateSpeed, wind.headwind),
    liftoff: calculateRequiredGroundSpeed(speeds.liftoffSpeed, wind.headwind),
    safe: calculateRequiredGroundSpeed(speeds.safeTakeoffSpeed, wind.headwind),
  };
  const groundRollInput = {
    ...input,
    density: densityData.density,
    wingArea: AIRCRAFT_CONFIG.wingArea,
    clTakeoff: AIRCRAFT_CONFIG.takeoffCL,
    cdTakeoff: AIRCRAFT_CONFIG.takeoffCD,
    staticThrust: AIRCRAFT_CONFIG.staticThrust,
    propWashEquivalentSpeed: AIRCRAFT_CONFIG.propWashEquivalentSpeed,
  };
  const groundRoll = calculateGroundRoll({
    ...groundRollInput,
    targetGroundSpeed: milestoneGroundSpeeds.safe,
    speedMilestones: milestoneGroundSpeeds,
  });
  const noWindGroundRoll = calculateGroundRoll({
    ...groundRollInput,
    targetGroundSpeed: speeds.safeTakeoffSpeed,
  });
  const rotateAndLiftoff = calculateRotateAndLiftoff({
    groundRoll,
    ...speeds,
  });
  const climb = calculateClimbPerformance({
    massKg: input.massKg,
    density: densityData.density,
    wingArea: AIRCRAFT_CONFIG.wingArea,
    cdTakeoff: AIRCRAFT_CONFIG.takeoffCD,
    trueAirspeed: speeds.safeTakeoffSpeed,
    thrust: groundRoll.liftoffThrust,
  });
  const abort = calculateAbortPoint({
    runwayLength: input.runwayLength,
    abortSpeed: groundRoll.abortSpeed,
    safeTakeoffSpeed: speeds.safeTakeoffSpeed,
    surface: input.surface,
  });
  const cg = calculateCGStatus({ cgPercent: input.cgPercent });
  const controls = calculateControlAdvice({
    crosswind: wind.crosswind,
    takeoffSpeed: speeds.safeTakeoffSpeed,
  });
  const runwayMargin = input.runwayLength - groundRoll.distance;
  const runwayUsage = (groundRoll.distance / input.runwayLength) * 100;
  const observedAtMs = weather.observedAt
    ? new Date(weather.observedAt).getTime()
    : Number.NaN;
  const weatherAgeMinutes =
    ["mgm-live", "open-meteo"].includes(weather.sourceType) &&
    Number.isFinite(observedAtMs)
      ? Math.max(0, (nowMs - observedAtMs) / 60000)
      : null;
  const risk = calculateRiskLevel({
    runwayMargin,
    runwayUsage,
    headwind: wind.headwind,
    crosswind: wind.crosswind,
    weatherAgeMinutes,
    weatherSourceType: weather.sourceType,
    weatherConfidence: weather.confidenceCode,
    stationDistanceKm: weather.stationDistanceKm,
    densityAltitudeM: densityData.densityAltitudeM,
    elevationAvailable: isFiniteNumber(input.elevationM),
    cg,
    climbRate: climb.rateOfClimb,
    abortSpeedSafe: abort.speedIsEnough,
    accelerateStopFits: abort.stopsWithinRunway,
    gustSpeedMs: weather.gustSpeedMs,
    windSpeedMs: weather.windSpeedMs,
    batteryPercent: input.batteryPercent,
    thrustPossible: groundRoll.possible,
  });

  return {
    ...densityData,
    stallSpeed,
    rotateSpeed: speeds.rotateSpeed,
    liftoffSpeed: speeds.liftoffSpeed,
    takeoffSpeed: speeds.safeTakeoffSpeed,
    requiredGroundSpeed: milestoneGroundSpeeds.safe,
    wind,
    groundRoll,
    noWindGroundRoll,
    rotateAndLiftoff,
    runwayMargin,
    runwayUsage,
    abort,
    climb,
    cg,
    controls,
    risk,
    weatherAgeMinutes,
    thrustWeightRatio:
      AIRCRAFT_CONFIG.staticThrust / (input.massKg * PHYSICS.gravity),
  };
}
