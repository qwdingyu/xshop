export const LAUNCH_MODES = Object.freeze({
  PUBLIC: "public",
  TRIAL: "trial",
});

export function normalizeLaunchMode(value) {
  const mode = String(value || LAUNCH_MODES.PUBLIC).trim().toLowerCase();
  return mode || LAUNCH_MODES.PUBLIC;
}

export function isSupportedLaunchMode(value) {
  const mode = normalizeLaunchMode(value);
  return mode === LAUNCH_MODES.PUBLIC || mode === LAUNCH_MODES.TRIAL;
}

export function shouldFailLaunchGate({ failures, warnings, mode }) {
  const failureCount = Number(failures || 0);
  const warningCount = Number(warnings || 0);
  const launchMode = normalizeLaunchMode(mode);

  if (!isSupportedLaunchMode(launchMode)) return true;
  if (failureCount > 0) return true;
  if (launchMode === LAUNCH_MODES.PUBLIC && warningCount > 0) return true;
  return false;
}

export function launchModeDescription(value) {
  const mode = normalizeLaunchMode(value);
  if (mode === LAUNCH_MODES.TRIAL) return "受控试运营模式：允许显式豁免产生的警告，但不允许失败";
  if (mode === LAUNCH_MODES.PUBLIC) return "公开正式上线模式：不允许失败，也不允许警告";
  return `未知上线模式：${mode}；仅支持 public 或 trial`;
}
