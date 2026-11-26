// 内置转写模型清单：只下载清单里的文件，并用固定 revision 和 SHA-256 校验。
// 下载源（镜像）不被信任——文件内容错一个字节都会被丢弃并换源重试。
// 清单数据来自 Systran/faster-whisper-small@536b066：model.bin 的哈希取自 Hugging Face LFS 元数据
// （经 hf-mirror.com 读取），其余文件由下载后本地计算；revision 固定，上游更新不会改变这里的内容。

export interface ModelFile {
  name: string;
  size: number;
  sha256: string;
}

export interface ModelManifestEntry {
  repo: string;
  revision: string;
  files: readonly ModelFile[];
}

export const MODEL_MANIFEST: Readonly<Record<string, ModelManifestEntry>> = {
  small: {
    repo: 'Systran/faster-whisper-small',
    revision: '536b0662742c02347bc0e980a01041f333bce120',
    files: [
      {
        name: 'config.json',
        size: 2370,
        sha256: 'b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828',
      },
      {
        name: 'tokenizer.json',
        size: 2203239,
        sha256: 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab',
      },
      {
        name: 'vocabulary.txt',
        size: 459861,
        sha256: '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913',
      },
      {
        name: 'model.bin',
        size: 483546902,
        sha256: '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671',
      },
    ],
  },
};

/**
 * 下载源，按探测结果择优、失败时依次兜底。URL 形如 `<源>/<repo>/resolve/<revision>/<file>`。
 * 开发和排障可用环境变量 TURNNOTE_MODEL_SOURCES（逗号分隔）覆盖。
 */
export const DEFAULT_MODEL_SOURCES: readonly string[] = [
  'https://huggingface.co',
  'https://hf-mirror.com',
];

/** sidecar 加载前要求存在的文件（services/asr-worker/worker.py 的 MODEL_FILES）；测试校验两者同步 */
export const SIDECAR_MODEL_FILES: readonly string[] = [
  'model.bin',
  'config.json',
  'tokenizer.json',
];

export function modelSizeBytes(entry: ModelManifestEntry): number {
  return entry.files.reduce((total, file) => total + file.size, 0);
}
