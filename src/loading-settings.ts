export const loadingAnimations = [
  { id: 'projector', name: 'Projetor de cinema' },
  { id: 'clapperboard', name: 'Claquete' },
  { id: 'film-reel', name: 'Rolo de filme' },
  { id: 'countdown', name: 'Contagem regressiva' },
  { id: 'spotlights', name: 'Refletores' },
  { id: 'jellyfin', name: 'Logotipo do Jellyfin' }
] as const;
export type LoadingAnimation = typeof loadingAnimations[number]['id'];
export type LoadingScreenSettings = { version: 1; animation: LoadingAnimation; brandText: string; message: string };
export const maxLoadingSettingsBytes = 7 * 1024;
export function defaultLoadingScreen(): LoadingScreenSettings {
  return { version: 1, animation: 'projector', brandText: 'SCREENHARBOUR', message: 'Preparando sua Página Inicial' };
}
export function loadingScreenKey(server: string, user: string): string {
  return `jellyfin-cinema.loading-screen.v1:${encodeURIComponent(server)}:${encodeURIComponent(user)}`;
}
export function parseLoadingScreen(value: unknown): LoadingScreenSettings {
  const invalid = () => new Error('Jellyfin returned invalid loading-screen settings. Try again.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const data = value as Record<string, unknown>;
  const text = (value: unknown, length: number): value is string => typeof value === 'string'
    && value.length <= length && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
  if (Object.keys(data).length !== 4 || data.version !== 1 || !loadingAnimations.some(option => option.id === data.animation)
    || !text(data.brandText, 60) || !text(data.message, 120)) throw invalid();
  return { version: 1, animation: data.animation as LoadingAnimation, brandText: data.brandText, message: data.message };
}
