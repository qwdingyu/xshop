import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const maintenance = readFileSync(new URL('./12-ops-maintenance.sh', import.meta.url), 'utf8')
const syncScript = readFileSync(new URL('./sync-turso-backup.mjs', import.meta.url), 'utf8')
const workflow = readFileSync(new URL('../.github/workflows/backup-daily.yml', import.meta.url), 'utf8')
const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')

describe('Turso backup contract', () => {
  it('uses the current platform snapshot export and validates the SQLite file', () => {
    expect(maintenance).toContain('turso db export')
    expect(maintenance).not.toContain('turso db dump')
    expect(maintenance).toContain('TURSO_API_TOKEN')
    expect(maintenance).toContain('TURSO_DB_NAME')
    expect(maintenance).toContain('--with-metadata')
    expect(maintenance).toContain('node scripts/sync-turso-backup.mjs')
    expect(maintenance).toContain('turso db show "${TURSO_DB_NAME}" --url')
    expect(syncScript).toContain('await client.sync()')
    expect(syncScript).toContain('syncUrl')
    expect(syncScript).toContain('TURSO_DB_NAME 与 TURSO_URL 指向不同数据库')
    expect(maintenance).toContain('PRAGMA integrity_check')
  })

  it('encrypts backups before the workflow uploads them', () => {
    expect(maintenance).toContain('BACKUP_ENCRYPTION_PASSPHRASE')
    expect(maintenance).toContain('openssl enc -aes-256-cbc')
    expect(workflow).toContain('bash scripts/12-ops-maintenance.sh backup-remote')
    expect(workflow).toContain('backups/*.enc')
    expect(workflow).toContain('if-no-files-found: error')
    expect(workflow).toContain('TURSO_CLI_VERSION: v1.0.30')
    expect(workflow).toContain('sha256sum -c -')
    expect(workflow).not.toContain("SELECT name FROM sqlite_master")
    expect(gitignore).toContain('/backups/')
  })
})
