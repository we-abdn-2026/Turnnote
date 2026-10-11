import { useEffect, useState, type ReactElement } from 'react';
import type { AppError, AppSettings, CapturePermissions } from '@shared/contracts';

interface AudioDeviceSelectorProps {
  onSettingsChange?: (settings: Partial<AppSettings>) => void;
}

type LoadingState = 'idle' | 'loading' | 'loaded' | 'error';

export function AudioDeviceSelector({ onSettingsChange }: AudioDeviceSelectorProps): ReactElement {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [permissions, setPermissions] = useState<CapturePermissions | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [loadingState, setLoadingState] = useState<LoadingState>('loading');
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<AppError | null>(null);

  // 加载设置和权限
  useEffect(() => {
    void Promise.all([
      window.turnnote.settings.get(),
      window.turnnote.recording.getPermissions(),
    ]).then(([settingsResult, permissionsResult]) => {
      if (!settingsResult.ok) {
        setLoadError(settingsResult.error);
        setLoadingState('error');
        return;
      }
      if (!permissionsResult.ok) {
        setLoadError(permissionsResult.error);
        setLoadingState('error');
        return;
      }
      setSettings(settingsResult.value);
      setPermissions(permissionsResult.value);
      setLoadError(null);
      setLoadingState('loaded');
    }).catch(() => {
      setLoadError({ code: 'INTERNAL', message: '加载失败，请重试' });
      setLoadingState('error');
    });
  }, []);

  // 加载可用的音频设备并监听设备变化
  useEffect(() => {
    if (permissions?.microphone !== 'granted') {
      return;
    }

    const loadDevices = (): void => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((deviceList) => {
          const audioInputs = deviceList.filter((d) => d.kind === 'audioinput');
          setDevices(audioInputs);
          setDeviceError(null);
        })
        .catch(() => {
          setDeviceError('无法获取音频设备列表');
          setDevices([]);
        });
    };

    loadDevices();

    // 监听设备变化
    navigator.mediaDevices.addEventListener('devicechange', loadDevices);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
    };
  }, [permissions]);

  const handleRetry = (): void => {
    window.location.reload();
  };

  const handleRefreshDevices = (): void => {
    if (permissions?.microphone === 'granted') {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((deviceList) => {
          const audioInputs = deviceList.filter((d) => d.kind === 'audioinput');
          setDevices(audioInputs);
          setDeviceError(null);
        })
        .catch(() => {
          setDeviceError('无法获取音频设备列表');
          setDevices([]);
        });
    }
  };

  async function handleMicrophoneChange(deviceId: string): Promise<void> {
    setSaveError(null);
    const update = { microphoneDeviceId: deviceId || null };
    const result = await window.turnnote.settings.update(update);
    if (result.ok) {
      setSettings(result.value);
      onSettingsChange?.(update);
    } else {
      setSaveError(result.error);
    }
  }

  async function handleSystemAudioChange(enabled: boolean): Promise<void> {
    setSaveError(null);
    const update = { includeSystemAudio: enabled };
    const result = await window.turnnote.settings.update(update);
    if (result.ok) {
      setSettings(result.value);
      onSettingsChange?.(update);
    } else {
      setSaveError(result.error);
    }
  }

  // 加载中状态
  if (loadingState === 'loading') {
    return <div className="device-selector loading">加载设备设置...</div>;
  }

  // 加载失败状态
  if (loadingState === 'error' || !settings || !permissions) {
    return (
      <div className="device-selector error-state">
        <h3>音频设备</h3>
        <div className="error-notice" role="alert">
          <strong>加载失败</strong>
          <p>{loadError?.message || '无法加载设备设置'}</p>
          {loadError?.code === 'NOT_IMPLEMENTED' && (
            <p className="hint">此功能尚未在后端实现，请等待后续开发。</p>
          )}
          <button type="button" onClick={handleRetry} className="retry-button">
            重试
          </button>
        </div>
      </div>
    );
  }

  const micPermission = permissions.microphone;
  const canSelectDevice = micPermission === 'granted';
  const hasDevices = devices.length > 0;
  // 检查当前选择的设备是否还存在
  const selectedDeviceExists =
    !settings.microphoneDeviceId ||
    devices.some((d) => d.deviceId === settings.microphoneDeviceId);

  return (
    <div className="device-selector">
      <h3>音频设备</h3>

      {/* 保存错误提示 */}
      {saveError && (
        <div className="error-notice" role="alert">
          <strong>保存失败</strong>
          <p>{saveError.message}</p>
        </div>
      )}

      {/* 麦克风权限提示 */}
      {micPermission !== 'granted' && (
        <div className="permission-notice" role="alert">
          {micPermission === 'denied' && (
            <>
              <strong>麦克风权限被拒绝</strong>
              <p>请在系统设置中授予麦克风权限后重启应用。</p>
            </>
          )}
          {micPermission === 'not-determined' && (
            <>
              <strong>需要麦克风权限</strong>
              <p>开始录音时会请求麦克风权限。</p>
            </>
          )}
          {['restricted', 'unknown'].includes(micPermission) && (
            <>
              <strong>无法访问麦克风</strong>
              <p>请检查系统设置中的麦克风权限。</p>
            </>
          )}
        </div>
      )}

      {/* 麦克风选择 */}
      <div className="device-option">
        <label htmlFor="microphone-select">
          麦克风设备
          {!canSelectDevice && <span className="disabled-hint"> (需要权限)</span>}
        </label>
        <div className="device-select-wrapper">
          <select
            id="microphone-select"
            value={settings.microphoneDeviceId ?? ''}
            onChange={(e) => void handleMicrophoneChange(e.target.value)}
            disabled={!canSelectDevice}
          >
            <option value="">默认麦克风</option>
            {!hasDevices && canSelectDevice && <option disabled>未检测到音频设备</option>}
            {devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `麦克风 ${device.deviceId.slice(0, 8)}`}
              </option>
            ))}
          </select>
          {canSelectDevice && (
            <button
              type="button"
              onClick={handleRefreshDevices}
              className="refresh-button"
              title="刷新设备列表"
            >
              ↻
            </button>
          )}
        </div>

        {/* 无设备状态 */}
        {!hasDevices && canSelectDevice && !deviceError && (
          <p className="warning">
            未检测到麦克风设备。请连接麦克风后点击刷新按钮重新检测。
            <br />
            注意:如果继续录音,可能会失败或无法捕获音频。
          </p>
        )}

        {/* 已选设备失效 */}
        {canSelectDevice && hasDevices && !selectedDeviceExists && (
          <p className="warning">
            之前选择的设备已不可用,已切换为默认麦克风。请重新选择设备。
          </p>
        )}

        {deviceError && <p className="error">{deviceError}</p>}
      </div>

      {/* 系统音频选项 */}
      <div className="device-option">
        <label htmlFor="system-audio-toggle">
          <input
            type="checkbox"
            id="system-audio-toggle"
            checked={settings.includeSystemAudio}
            onChange={(e) => void handleSystemAudioChange(e.target.checked)}
          />
          <span>同时录制系统音频</span>
        </label>
        <p className="hint">
          {settings.includeSystemAudio
            ? '将混录系统播放的音频(如远程会议中其他人的声音)。'
            : '仅录制麦克风音频,不包含系统播放的声音。'}
        </p>
      </div>
    </div>
  );
}
