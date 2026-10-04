import { Activity, Gauge, Plane, Rocket } from 'lucide-react';

export const categories = [
  {
    id: 'rocket',
    title: 'Roket Sistemleri',
    subtitle: 'Model roket testleri için yörünge, simülasyon ve güvenli alan analizleri.',
    icon: Rocket,
    accent: 'cyan',
  },
  {
    id: 'uav',
    title: 'İHA Sistemleri',
    subtitle: 'Sabit kanat İHA operasyonları için performans ve hazırlık analizleri.',
    icon: Plane,
    accent: 'blue',
  },
];

export const modules = [
  {
    id: 'bayhes',
    categoryId: 'rocket',
    title: 'BAYHES',
    shortTitle: 'BAYHES',
    description:
      'Roket Düşüş Alanı Tahmin ve Risk Analiz Sistemi',
    status: 'Hazır',
    statusTone: 'ready',
    icon: Activity,
    component: 'RocketBayhesModule',
    externalPath: '/bayhes-risk/index.html',
    actionLabel: 'Modülü Aç',
  },
  {
    id: 'performance',
    categoryId: 'uav',
    title: 'Kalkış Destek Asistanı',
    shortTitle: 'Kalkış Asistanı',
    description:
      'Sabit kanat İHA için meteoroloji, pist, kalkış, abort ve kontrol tavsiyesi karar desteği.',
    status: 'Hazır',
    statusTone: 'ready',
    icon: Gauge,
    component: 'UavPerformance',
    actionLabel: 'Modülü Aç',
  },
  {
    id: 'imu-simulation',
    categoryId: 'uav',
    title: 'IMU Simülasyonu',
    shortTitle: 'IMU',
    description:
      'ESP32-S3 + MPU6050 üzerinden gelen roll, pitch, yaw verileriyle gerçek zamanlı 3D uçak yönelim simülasyonu.',
    status: 'Hazır',
    statusTone: 'ready',
    icon: Activity,
    component: 'ImuSimulationModule',
    externalPath: '/legacy-dashboard/index.html#imuSimulationPage',
    actionLabel: 'Simülasyonu Aç',
  },
];

export function getCategory(categoryId) {
  return categories.find((category) => category.id === categoryId);
}

export function getModulesByCategory(categoryId) {
  return modules.filter((module) => module.categoryId === categoryId);
}

export function getModule(categoryId, moduleId) {
  return modules.find((module) => module.categoryId === categoryId && module.id === moduleId);
}
