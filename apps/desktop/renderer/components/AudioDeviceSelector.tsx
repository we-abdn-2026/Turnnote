import { useEffect, useState, type ReactElement } from 'react';
import type { AppSettings, CapturePermissions } from '@shared/contracts';

interface AudioDeviceSelectorProps {
  onSettingsChange?: (settings: Partial<AppSettings>) => void;
}

export function AudioDeviceSelector({ onSettingsChange }: AudioDeviceSelectorProps): ReactElement {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [permissions, setPermissions] = useState<CapturePermissions | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 加载设置和权限
  useEffect(() => {
    void loadSettingsAndPermissions();
  }, []);

  // 加载可用的音频设备
  useEffect(() => {
    if (permissions?.microphone === 'granted') {
      void loadDevices();
    }
  }, [permissions]);

  async function loadSettingsAndPermissions(): Promise<void> {
    const [settingsResult, permissionsResult] = await Promise.all([
      window.turnnote.settings.get(),
      window.turnnote.recording.getPermissions(),
    ]);

    if (settingsResult.ok) {
      setSettings(settingsResult.value);
    }

    if (permissionsResult.ok) {
      setPermissions(permissionsResult.value);
    }
  }

  async function loadDevices(): Promise<void> {
    try {
      const deviceList = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = deviceList.filter((d) => d.kind === 'audioinput');
      setDevices(audioInputs);
      setError(null);
    } catch (err) {
      setError('无法获取音频设备列表');
      setDevices([]);
    }
  }

  async function handleMicrophoneChange(deviceId: string): Promise<void> {
    const update = { microphoneDeviceId: deviceId || null };
    const result = await window.turnnote.settings.update(update);
    if (result.ok) {
      setSettings(result.value);
      onSettingsChange?.(update);
    }
  }

  async function handleSystemAudioChange(enabled: boolean): Promise<void> {
    const update = { includeSystemAudio: enabled };
    const result = await window.turnnote.settings.update(update);
    if (result.ok) {
      setSettings(result.value);
      onSettingsChange?.(update);
    }
  }

  if (!settings || !permissions) {
    return <div className="device-selector loading">加载设备设置...</div>;
  }

  const micPermission = permissions.microphone;
  const canSelectDevice = micPermission === 'granted';

  return (
    <div className="device-selector">
      <h3>音频设备</h3>

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
        <select
          id="microphone-select"
          value={settings.microphoneDeviceId ?? ''}
          onChange={(e) => void handleMicrophoneChange(e.target.value)}
          disabled={!canSelectDevice}
        >
          <option value="">默认麦克风</option>
          {devices.length === 0 && canSelectDevice && <option disabled>未检测到音频设备</option>}
          {devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || `麦克风 ${device.deviceId.slice(0, 8)}`}
            </option>
          ))}
        </select>
        {devices.length === 0 && canSelectDevice && !error && (
          <p className="hint">未检测到麦克风设备,将使用系统默认设备。</p>
        )}
        {error && <p className="error">{error}</p>}
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
