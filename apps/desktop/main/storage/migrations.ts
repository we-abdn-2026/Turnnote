import type Database from 'better-sqlite3';
import initialSql from './migrations/001_initial.sql?raw';
import lifecycleSql from './migrations/002_job_lifecycle.sql?raw';

export interface Migration {
  version: number;
  sql: string;
}
export const migrations: readonly Migration[] = [
  { version: 1, sql: initialSql },
  { version: 2, sql: lifecycleSql },
];

export function migrate(db: Database.Database, steps: readonly Migration[] = migrations): void {
  if (steps.some((step, i) => step.version !== i + 1))
    throw new Error('Invalid migration sequence.');
  // 整批升级原子提交，任何一步失败都保留升级前的数据与 user_version。
  db.transaction(() => {
    // 获取写锁后再读版本，避免两个初始化连接重复执行同一迁移。
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version > steps.length) throw new Error('Database version is newer than this application.');
    for (const step of steps.slice(version)) {
      db.exec(step.sql);
      db.pragma(`user_version = ${step.version}`);
    }
  }).immediate();
}
