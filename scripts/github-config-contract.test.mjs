import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const activeDeploy = read(".github/workflows/deploy.yml");
const activeBackup = read(".github/workflows/backup-daily.yml");
const activeCleanup = read(".github/workflows/cleanup-schedule.yml");
const setupScript = read("scripts/10-setup-github.sh");
const deploySetupWrapper = read(".deploy/06-setup-github.sh");
const workerDeployScript = read(".deploy/03-deploy-worker.sh");
const packageJson = read("package.json");

describe("GitHub configuration contract", () => {
  it("keeps sensitive values in Secrets and non-sensitive deployment metadata in Variables", () => {
    expect(activeBackup).toContain("TURSO_API_TOKEN: ${{ secrets.TURSO_API_TOKEN }}");
    expect(activeBackup).toContain("TURSO_DB_NAME: ${{ vars.TURSO_DB_NAME }}");
    expect(activeBackup).not.toContain("secrets.TURSO_DB_NAME");
    expect(activeDeploy).toContain("EMAIL_FROM: ${{ vars.EMAIL_FROM }}");
    expect(activeDeploy).not.toContain("secrets.EMAIL_FROM");
    expect(activeDeploy).not.toContain("secrets.DEPLOY_MODE");
    expect(activeDeploy).toContain("append_secret()");
    expect(activeDeploy).toContain("return 0");
    expect(activeDeploy).not.toContain('[ -n "$value" ] && printf');
  });

  it("uses APP_ORIGIN as the single deployed and verified public origin", () => {
    expect(activeDeploy).toContain("APP_ORIGIN: ${{ vars.APP_ORIGIN }}");
    expect(activeDeploy).toContain("BASE_URL: ${{ vars.APP_ORIGIN }}");
    expect(activeDeploy).not.toContain("mailforwdy");
    expect(activeDeploy).not.toContain("format('https://{0}.workers.dev'");
    expect(workerDeployScript).toContain('--var "APP_ORIGIN:${WORKER_ORIGIN}"');
    expect(workerDeployScript).not.toContain("BASE_URL=$(deploy_workers)");
    expect(packageJson).toContain('wrangler deploy --var \\"APP_ORIGIN:$APP_ORIGIN\\"');
    expect(activeDeploy).toContain("admin_ready=false");
    expect(activeDeploy).toContain("Deployed admin credential did not become active");
    expect(activeCleanup).toContain("APP_URL: ${{ vars.APP_ORIGIN }}");
    expect(activeCleanup).toContain('if [ -z "$APP_URL" ] || [ -z "$ADMIN_TOKEN" ]');
    expect(activeCleanup).toContain('Authorization: Bearer ${ADMIN_TOKEN}');
    expect(activeCleanup).not.toContain("secrets.ESHOP_APP_URL");
  });

  it("keeps one canonical workflow source instead of copy-and-replace templates", () => {
    expect(activeBackup).toContain("Validate backup configuration");
    expect(activeBackup).toContain("BACKUP_ENCRYPTION_PASSPHRASE");
    expect(activeBackup).toContain("backups/*.enc");
    expect(activeBackup).not.toContain("backups/*.sql");
    for (const name of ["deploy.yml", "backup-daily.yml", "cleanup-schedule.yml"]) {
      expect(existsSync(new URL(`../.deploy/workflows/${name}`, import.meta.url))).toBe(false);
    }
    expect(deploySetupWrapper).toContain("scripts/10-setup-github.sh");
  });

  it("does not retain legacy Global API Key or dead configuration paths", () => {
    for (const source of [activeDeploy, deploySetupWrapper]) {
      expect(source).not.toContain("CF_GLOBAL_API_KEY");
      expect(source).not.toContain("CF_AUTH_EMAIL");
      expect(source).not.toContain("GROUP_NAME");
    }
    expect(setupScript).toContain("legacy_secrets");
    expect(setupScript).toContain("CF_GLOBAL_API_KEY");
    expect(setupScript).not.toContain('gh secret set CF_GLOBAL_API_KEY');
    expect(setupScript).not.toContain('gh secret set TURSO_DB_NAME');
    expect(setupScript).toContain("APP_ORIGIN BIND_DOMAIN DEPLOY_MODE EMAIL_FROM TURSO_DB_NAME WORKER_NAME");
    expect(setupScript).toContain('gh variable set "$name"');
    expect(setupScript).toContain("turso_token_candidate");
    expect(setupScript).toContain("https://api.turso.tech/v1/organizations");
    expect(setupScript).toContain("set_github_secret");
    expect(setupScript).toContain("for attempt in 1 2 3");
    expect(setupScript).not.toContain("turso auth whoami >/dev/null");
  });
});
