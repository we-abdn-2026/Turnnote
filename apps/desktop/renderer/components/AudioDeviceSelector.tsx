import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Icon } from '../ui/icons';
import type {
  AppError,
  AppSettings,
  CapturePermissions,
  PermissionTarget,
} from '@shared/contracts';
import { systemAudioBlocked } from '../audio/permissions';
import {
  LOAD_FAILED_MESSAGE,
  deriveDeviceView,
  loadDeviceSettings,
  saveDeviceSettings,
  scanAudioInputs,
} from './audio-device-state';

type LoadingState = 'loading' | 'loaded' | 'error';

/** locked：录音进行中，设备选择只影响下一次录音，暂时锁定避免误解 */
export function AudioDeviceSelector({ locked = false }: { locked?: boolean }): ReactElement {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [permissions, setPermissions] = useState<CapturePermissions | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>('loading');
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  const [scanKey, setScanKey] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);
  // 枚举可能乱序完成（#72）：只接受最后一次发起的扫描结果
  const scanRequest = useRef(0);

  // 加载设置和权限；loadKey 变化即重试
  useEffect(() => {
    let active = true;
    void loadDeviceSettings(window.turnnote).then((outcome) => {
      if (!active) return;
      if (outcome.ok) {
        setSettings(outcome.settings);
        setPermissions(outcome.permissions);
        setLoadError(null);
        setLoadingState('loaded');
      } else {
        setLoadError(outcome.error);
        setLoadingState('error');
      }
    });
    return () => {
      active = false;
    };
  }, [loadKey]);

  // 枚举音频输入设备并监听 devicechange；scanKey 变化即手动刷新
  useEffect(() => {
    if (permissions?.microphone !== 'granted') return;
    let active = true;
    const scan = (): void => {
      const request = ++scanRequest.current;
      void scanAudioInputs(navigator.mediaDevices).then((outcome) => {
        if (!active || request !== scanRequest.current) return;
        setDevices(outcome.devices);
        setDeviceError(outcome.error);
      });
    };
    scan();
    navigator.mediaDevices?.addEventListener('devicechange', scan);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener('devicechange', scan);
    };
  }, [permissions, scanKey]);

  /** 打开系统里对应的权限设置页；这个平台没有时，告诉用户去哪里手动找 */
  async function openPermissionSettings(target: PermissionTarget): Promise<void> {
    setOpenError(null);
    const result = await window.turnnote.recording.openPermissionSettings(target).catch(() => null);
    if (!result?.ok) {
      setOpenError('无法自动打开系统设置，请手动前往：系统设置 → 隐私与安全性。');
    }
  }

  const handleRetry = (): void => {
    setLoadingState('loading');
    setLoadError(null);
    setLoadKey((key) => key + 1);
  };

  async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
    setSaveError(null);
    setSaving(true);
    const outcome = await saveDeviceSettings(window.turnnote, patch);
    if (outcome.ok) setSettings(outcome.settings);
    else setSaveError(outcome.message);
    setSaving(false);
  }

  if (loadingState === 'loading') {
    return (
      <div className="device-selector loading" aria-busy="true">
        <h3>音频输入</h3>
        <p className="hint">加载设备设置...</p>
      </div>
    );
  }

  if (loadingState === 'error' || !settings || !permissions) {
    return (
      <div className="device-selector error-state">
        <h3>音频输入</h3>
        <div className="error-notice" role="alert">
          <strong>加载失败</strong>
          <p>{loadError?.message ?? LOAD_FAILED_MESSAGE}</p>
          {loadError?.code === 'NOT_IMPLEMENTED' && (
            <p>当前版本尚未提供该功能，暂时无法选择录音设备。</p>
          )}
          <button type="button" onClick={handleRetry} className="key key-quiet retry-button">
            <Icon name="refresh" />
            重试
          </button>
        </div>
      </div>
    );
  }

  const micPermission = permissions.microphone;
  const view = deriveDeviceView(settings, permissions, devices, deviceError);

  return (
    <div className="device-selector" data-locked={locked ? 'true' : undefined}>
      <h3>音频输入</h3>

      {saveError && (
        <div className="error-notice" role="alert">
          <strong>保存失败</strong>
          <p>{saveError}</p>
        </div>
      )}

      {micPermission !== 'granted' && (
        <div className="permission-notice" role="alert">
          {micPermission === 'denied' && (
            <>
              <strong>麦克风权限被拒绝</strong>
              <p>请在系统设置中允许 Turnnote 使用麦克风，然后重启应用。</p>
              <button
                type="button"
                className="key key-quiet"
                onClick={() => void openPermissionSettings('microphone')}
              >
                打开系统设置
              </button>
            </>
          )}
          {micPermission === 'not-determined' && (
            <>
              <strong>需要麦克风权限</strong>
              <p>开始录音时系统会请求麦克风权限，授权后即可选择设备。</p>
            </>
          )}
          {(micPermission === 'restricted' || micPermission === 'unknown') && (
            <>
              <strong>无法访问麦克风</strong>
              <p>请在系统设置中检查 Turnnote 的麦克风权限。</p>
            </>
          )}
        </div>
      )}

      <div className="device-option">
        <label htmlFor="microphone-select">
          <Icon name="mic" />
          <span className="visually-hidden">麦克风设备</span>
          {!view.canSelectDevice && <span className="disabled-hint"> (需要权限)</span>}
        </label>
        <div className="device-select-wrapper">
          <select
            id="microphone-select"
            value={settings.microphoneDeviceId ?? ''}
            onChange={(e) => void saveSettings({ microphoneDeviceId: e.target.value || null })}
            className="field field-select"
            disabled={!view.canSelectDevice || saving || locked}
          >
            {view.options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
          {view.canSelectDevice && (
            <button
              type="button"
              onClick={() => setScanKey((key) => key + 1)}
              className="key key-icon refresh-button"
              aria-label="刷新设备列表"
              data-tip="刷新设备列表"
              data-tip-align="end"
              disabled={locked}
            >
              <Icon name="refresh" />
            </button>
          )}
        </div>

        {view.canSelectDevice && !view.scanned && <p className="hint">正在检测音频设备...</p>}

        {view.noDevices && (
          <p className="warning" role="status">
            未检测到麦克风，录音将无法采集麦克风声音。请连接麦克风后点击刷新。
          </p>
        )}

        {view.selectedMissing && (
          <p className="warning" role="status">
            已选择的麦克风当前不可用。请重新连接该设备后点击刷新，或改选其他设备。
          </p>
        )}

        {deviceError && <p className="error">{deviceError}</p>}
      </div>

      <div className="device-option">
        <label className="switch" htmlFor="system-audio-toggle">
          <input
            type="checkbox"
            id="system-audio-toggle"
            checked={settings.includeSystemAudio}
            onChange={(e) => void saveSettings({ includeSystemAudio: e.target.checked })}
            disabled={saving || locked}
          />
          <span className="switch-track" aria-hidden="true" />
          <Icon name="speaker" />
          <span>同时录制系统音频</span>
          <span className="switch-state" aria-hidden="true" />
        </label>
        {settings.includeSystemAudio && systemAudioBlocked(permissions) && (
          <div className="permission-notice" role="status">
            <strong>系统音频需要“屏幕与系统音频录制”权限</strong>
            <p>
              目前没有授权，录音时只能录到麦克风。请在系统设置的“屏幕与系统音频录制”里打开 Turnnote
              的开关，然后重新打开 Turnnote。
              {import.meta.env.DEV && ' 开发模式下需要允许的是 Electron，或启动它的终端应用。'}
            </p>
            <button
              type="button"
              className="key key-quiet"
              onClick={() => void openPermissionSettings('screen')}
            >
              打开系统设置
            </button>
          </div>
        )}
        {openError && (
          <p className="warning" role="status">
            {openError}
          </p>
        )}
      </div>
    </div>
  );
}
