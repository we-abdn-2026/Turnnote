// 按 .github/labels.json 同步 GitHub 标签：创建、按 aliases 重命名、更新颜色和描述。
// 不删除任何标签；未定义的标签只列出。已有 issue 上的标签随重命名自动迁移。
//
// 用法：node scripts/sync-labels.mjs [--apply]   默认只预览
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const apply = process.argv.includes('--apply');
const desired = JSON.parse(readFileSync('.github/labels.json', 'utf8'));

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' });
const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
const existing = JSON.parse(gh(['api', '--paginate', `repos/${repo}/labels?per_page=100`]));
const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label]));
const claimed = new Set();

for (const label of desired) {
  const exact = byName.get(label.name.toLowerCase());
  const alias = (label.aliases ?? []).map((name) => byName.get(name.toLowerCase())).find(Boolean);
  const current = exact ?? alias;
  const fields = ['-f', `color=${label.color}`, '-f', `description=${label.description}`];

  if (!current) {
    console.log(`create  ${label.name}`);
    if (apply) {
      gh(['api', '-X', 'POST', `repos/${repo}/labels`, '-f', `name=${label.name}`, ...fields]);
    }
    continue;
  }

  claimed.add(current.name.toLowerCase());
  const renamed = current.name !== label.name;
  const changed =
    renamed ||
    current.color.toLowerCase() !== label.color ||
    (current.description ?? '') !== label.description;
  if (!changed) continue;

  console.log(renamed ? `rename  ${current.name} → ${label.name}` : `update  ${label.name}`);
  if (apply) {
    const path = `repos/${repo}/labels/${encodeURIComponent(current.name)}`;
    gh(['api', '-X', 'PATCH', path, '-f', `new_name=${label.name}`, ...fields]);
  }
}

for (const label of existing) {
  if (!claimed.has(label.name.toLowerCase()))
    console.log(`keep    ${label.name}（未在 labels.json 中定义）`);
}

if (!apply) console.log('\n预览完成。执行 `npm run labels:sync -- --apply` 应用。');
