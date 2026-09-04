// input: Managed-auth, Market, Catalog, marketing, and desktop release workflows plus Worker route configuration
// output: Regression coverage for service ownership, secret scope, and independent deployment boundaries
// pos: Contract keeping data-source and Skills deployment authority out of desktop publication

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

const ROOT = join(import.meta.dir, '..', '..')

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

type WorkflowStep = {
  env?: Record<string, unknown>
  if?: string
  name?: string
  run?: string
}

type WorkflowJob = {
  env?: Record<string, unknown>
  steps?: WorkflowStep[]
}

function readDeployJob(path: string): WorkflowJob {
  const workflow = yaml.load(readRepoFile(path)) as {
    jobs?: Record<string, WorkflowJob>
  }

  const deploy = workflow.jobs?.deploy
  expect(deploy).toBeDefined()
  return deploy ?? {}
}

function findStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name)
  expect(step).toBeDefined()
  return step ?? {}
}

function readWorkflowJobs(path: string): Record<string, WorkflowJob> {
  const workflow = yaml.load(readRepoFile(path)) as {
    jobs?: Record<string, WorkflowJob>
  }

  return workflow.jobs ?? {}
}

describe('managed auth deployment', () => {
  it('deploys in dependency order and supports read-only verification', () => {
    const workflowPath = join(ROOT, '.github/workflows/deploy-managed-auth.yml')
    expect(existsSync(workflowPath)).toBe(true)

    const workflow = readFileSync(workflowPath, 'utf8')
    const gatewayDeploy = workflow.indexOf('Deploy model gateway')
    const toolGatewayDeploy = workflow.indexOf('Deploy tool gateway')
    const brokerDeploy = workflow.indexOf('Deploy auth broker')

    expect(workflow).toContain('workflow_call:')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('deploy:')
    expect(workflow).toContain('DEPLOY_MANAGED_AUTH')
    expect(workflow).toContain('Verify managed auth integration')
    expect(workflow).toContain('Verify Skills Market auth integration')
    expect(workflow).toContain('STORYFLOW_CLIENT_SESSION_JWT_CURRENT_SECRET')
    expect(workflow).toContain('STORYFLOW_GATEWAY_JWT_CURRENT_SECRET')
    expect(workflow).toContain('STORYFLOW_SKILLS_MARKET_JWT_CURRENT_SECRET')
    expect(workflow).not.toContain('STORYFLOW_TOOL_GATEWAY_JWT_CURRENT_SECRET')
    expect(workflow).not.toContain('STORYFLOW_TOOL_GATEWAY_JWT_PRIVATE_KEY')
    expect(workflow).not.toContain('ANYSEARCH_API_KEY')
    expect(workflow).toContain('model_access_token_invalid')
    expect(workflow).toContain('tool_access_token_invalid')
    expect(workflow).toContain('client_session_token_invalid')
    expect(workflow).toContain('MODEL_CATALOG_RESPONSE_PATH')
    expect(workflow).not.toContain('MARKET_TOKEN_RESPONSE_PATH')
    expect(workflow).toContain('TOOL_TOKEN_RESPONSE_PATH')
    expect(workflow).toContain('TOOL_SEARCH_RESPONSE_PATH')
    expect(workflow).toContain('payload.exp - now <= 12 * 60 * 60 + 5 * 60')
    expect(workflow).toContain('gemini-3.8-flash')
    expect(workflow).toContain('gemini-3.7-flash')
    expect(gatewayDeploy).toBeGreaterThan(0)
    expect(toolGatewayDeploy).toBeGreaterThan(gatewayDeploy)
    expect(brokerDeploy).toBeGreaterThan(toolGatewayDeploy)
    expect(workflow).not.toContain('wangsu')
  })

  it('scopes managed-auth production authority to the steps that consume it', () => {
    const deploy = readDeployJob('.github/workflows/deploy-managed-auth.yml')
    const productionEnv = [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'STORYFLOW_CLIENT_SESSION_JWT_CURRENT_SECRET',
      'STORYFLOW_GATEWAY_JWT_CURRENT_SECRET',
      'STORYFLOW_SKILLS_MARKET_JWT_CURRENT_SECRET',
    ]

    for (const name of productionEnv) {
      expect(deploy.env).not.toHaveProperty(name)
      expect(findStep(deploy, 'Install dependencies').env).not.toHaveProperty(name)
      expect(findStep(deploy, 'Test managed auth contract').env).not.toHaveProperty(name)
    }

    expect(findStep(deploy, 'Verify deployment inputs').env).toEqual({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ vars.CLOUDFLARE_ACCOUNT_ID }}',
      STORYFLOW_CLIENT_SESSION_JWT_CURRENT_SECRET: '${{ secrets.STORYFLOW_CLIENT_SESSION_JWT_CURRENT_SECRET }}',
      STORYFLOW_GATEWAY_JWT_CURRENT_SECRET: '${{ secrets.STORYFLOW_GATEWAY_JWT_CURRENT_SECRET }}',
      STORYFLOW_SKILLS_MARKET_JWT_CURRENT_SECRET: '${{ secrets.STORYFLOW_SKILLS_MARKET_JWT_CURRENT_SECRET }}',
    })
    expect(findStep(deploy, 'Deploy model gateway').env).toEqual({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ vars.CLOUDFLARE_ACCOUNT_ID }}',
      STORYFLOW_GATEWAY_JWT_CURRENT_SECRET: '${{ secrets.STORYFLOW_GATEWAY_JWT_CURRENT_SECRET }}',
    })
    expect(findStep(deploy, 'Deploy tool gateway').env).toEqual({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ vars.CLOUDFLARE_ACCOUNT_ID }}',
    })
    expect(findStep(deploy, 'Deploy auth broker').env).toEqual({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ vars.CLOUDFLARE_ACCOUNT_ID }}',
      STORYFLOW_CLIENT_SESSION_JWT_CURRENT_SECRET: '${{ secrets.STORYFLOW_CLIENT_SESSION_JWT_CURRENT_SECRET }}',
      STORYFLOW_GATEWAY_JWT_CURRENT_SECRET: '${{ secrets.STORYFLOW_GATEWAY_JWT_CURRENT_SECRET }}',
      STORYFLOW_SKILLS_MARKET_JWT_CURRENT_SECRET: '${{ secrets.STORYFLOW_SKILLS_MARKET_JWT_CURRENT_SECRET }}',
    })
    expect(findStep(deploy, 'Verify managed auth integration').env).toEqual({
      STORYFLOW_CLIENT_SESSION_JWT_CURRENT_SECRET: '${{ secrets.STORYFLOW_CLIENT_SESSION_JWT_CURRENT_SECRET }}',
    })
    expect(findStep(deploy, 'Verify Skills Market auth integration')).toMatchObject({
      if: '${{ inputs.deploy || inputs.verify_skills_market_auth }}',
      env: {
        STORYFLOW_CLIENT_SESSION_JWT_CURRENT_SECRET: '${{ secrets.STORYFLOW_CLIENT_SESSION_JWT_CURRENT_SECRET }}',
      },
      run: 'bun run scripts/verify-skills-market-auth.ts',
    })
  })

  it('gates desktop release on live market consumer contracts and the positive auth canary', () => {
    const releaseWorkflow = readRepoFile('.github/workflows/release.yml')
    const jobs = readWorkflowJobs('.github/workflows/release.yml')

    // The positive Broker → Skills Registry canary must run on every release,
    // not only when managed auth is redeployed.
    expect(releaseWorkflow).toMatch(/verify-managed-auth:[\s\S]*?with:\n\s+deploy: false\n\s+verify_skills_market_auth: true/)

    const marketContracts = jobs['verify-market-contracts']
    expect(marketContracts).toBeDefined()
    expect(findStep(marketContracts ?? {}, 'Verify live Skills Market consumer contract').run)
      .toBe('bun run scripts/verify-skills-market.ts')
    expect(findStep(marketContracts ?? {}, 'Verify live MCP Market consumer contract').run)
      .toBe('bun run scripts/verify-mcp-market.ts')
    expect(releaseWorkflow).toMatch(/verify-release:\n\s+needs:\n\s+- validate\n\s+- verify-managed-auth\n\s+- verify-market-contracts/)
    expect(existsSync(join(ROOT, 'scripts/verify-mcp-market.ts'))).toBe(true)
  })

  it('keeps Skills Registry deployment outside the desktop repository', () => {
    const managedAuthWorkflow = readRepoFile('.github/workflows/deploy-managed-auth.yml')
    const catalogWorkflow = readRepoFile('.github/workflows/validate-catalog.yml')
    const releaseWorkflow = readRepoFile('.github/workflows/release.yml')
    const packageManifest = JSON.parse(readRepoFile('package.json')) as {
      scripts: Record<string, string>
    }

    expect(managedAuthWorkflow).not.toContain('Migrate and deploy Skills Market')
    expect(managedAuthWorkflow).toContain('Verify Skills Market auth integration')
    expect(managedAuthWorkflow).not.toContain('storyflow-skills.zjding.com')
    expect(existsSync(join(ROOT, '.github/workflows/deploy-skills-market.yml'))).toBe(false)
    expect(existsSync(join(ROOT, 'apps/skills-market'))).toBe(false)
    expect(existsSync(join(ROOT, 'scripts/verify-skills-market.ts'))).toBe(true)
    expect(existsSync(join(ROOT, 'scripts/verify-skills-market-auth.ts'))).toBe(true)
    expect(catalogWorkflow).toContain('name: Validate Catalog Data Source')
    expect(catalogWorkflow).toContain('uv run --frozen --project apps/catalog-api')
    expect(catalogWorkflow).toContain('working-directory: apps/catalog-api/mcp')
    expect(catalogWorkflow).toContain('bun test src/index.test.ts')
    expect(catalogWorkflow).not.toContain('172.16.33.103')
    expect(releaseWorkflow).not.toContain('STORYFLOW_SKILLS_MARKET_JWT_CURRENT_SECRET')
    expect(releaseWorkflow).not.toContain('STORYFLOW_GATEWAY_JWT_CURRENT_SECRET')
    expect(releaseWorkflow).not.toContain('storyflow-skills.zjding.com')
    expect(releaseWorkflow).not.toContain('172.16.33.103')
    expect(packageManifest.scripts['validate:dev']).not.toContain('test:catalog-api')
    expect(packageManifest.scripts.test).toContain("':!apps/catalog-api/**'")
    expect(packageManifest.scripts.test).not.toContain('apps/skills-market')
    expect(packageManifest.scripts['skills-market:verify']).toBe('bun run scripts/verify-skills-market.ts')
  })

  it('scopes marketing production authority to verification and deployment', () => {
    const deploy = readDeployJob('.github/workflows/deploy-marketing.yml')
    const productionEnv = [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'STORYFLOW_PAGES_PROJECT_NAME',
    ]

    for (const name of productionEnv) {
      expect(deploy.env).not.toHaveProperty(name)
      expect(findStep(deploy, 'Install dependencies').env).not.toHaveProperty(name)
      expect(findStep(deploy, 'Build marketing site').env).not.toHaveProperty(name)
    }

    expect(findStep(deploy, 'Verify deployment configuration').env).toEqual({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ vars.CLOUDFLARE_ACCOUNT_ID }}',
    })
    expect(findStep(deploy, 'Deploy marketing site to Cloudflare Pages').env).toEqual({
      CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}',
      CLOUDFLARE_ACCOUNT_ID: '${{ vars.CLOUDFLARE_ACCOUNT_ID }}',
      STORYFLOW_PAGES_PROJECT_NAME: "${{ vars.STORYFLOW_PAGES_PROJECT_NAME || 'storyflow' }}",
    })
  })

  it('keeps authenticated dependency installs from running lifecycle code', () => {
    const workflowPaths = [
      '.github/workflows/deploy-marketing.yml',
      '.github/workflows/release.yml',
      '.github/workflows/validate-server.yml',
      '.github/workflows/validate.yml',
    ]

    for (const path of workflowPaths) {
      const installSteps = Object.values(readWorkflowJobs(path))
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.name === 'Install dependencies')

      expect(installSteps.length, `${path} should define an install step`).toBeGreaterThan(0)

      for (const step of installSteps) {
        expect(step.run).toContain('bun install')
        // Bun's --ignore-scripts prevents project lifecycle hooks while still resolving packages.
        expect(step.run).toContain('--ignore-scripts')
        // Keep the token scoped to install so private registry/git dependencies remain resolvable.
        expect(step.env).toEqual({ GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' })
      }
    }
  })

  it('verifies the release Gemini models without redeploying managed auth during desktop release', () => {
    const releaseWorkflow = readRepoFile('.github/workflows/release.yml')
    const deployWorkflow = readRepoFile('.github/workflows/deploy-managed-auth.yml')
    const verifyIntegration = findStep(
      readDeployJob('.github/workflows/deploy-managed-auth.yml'),
      'Verify managed auth integration',
    ).run ?? ''

    expect(releaseWorkflow).toContain('verify-managed-auth:')
    expect(releaseWorkflow).toContain('deploy: false')
    expect(releaseWorkflow).toMatch(/create-release:\n\s+needs: preflight-release-secrets/)
    expect(releaseWorkflow).toMatch(/verify-release:\n\s+needs:\n\s+- validate\n\s+- verify-managed-auth/)
    expect(releaseWorkflow).not.toContain('STORYFLOW_SKILLS_MARKET_JWT_CURRENT_SECRET')
    expect(releaseWorkflow).not.toContain('STORYFLOW_GATEWAY_JWT_CURRENT_SECRET')
    expect(deployWorkflow).toContain('DEPLOY_MANAGED_AUTH: ${{ inputs.deploy }}')
    expect(deployWorkflow).toContain('if: ${{ inputs.deploy }}')
    expect(deployWorkflow).not.toContain('github.event_name != \'workflow_call\' || inputs.deploy')
    expect(verifyIntegration).toContain('gemini-3.8-flash')
    expect(verifyIntegration).toContain('gemini-3.7-flash')
    expect(verifyIntegration).toContain('"thinkingLevel":"low"')
    expect(verifyIntegration).toContain('GEMINI_CANARY_RESPONSE_PATH')
    expect(verifyIntegration).toContain('No generated text')
    expect(readRepoFile('apps/auth-broker-worker/wrangler.toml')).toContain('workers_dev = false')
    expect(readRepoFile('apps/model-gateway-worker/wrangler.toml')).toContain('workers_dev = false')
    expect(readRepoFile('apps/tool-gateway-worker/wrangler.toml')).toContain('workers_dev = false')
    expect(readRepoFile('apps/tool-gateway-worker/wrangler.toml')).toContain('name = "SEARCH_RATE_LIMITER"')
    expect(readRepoFile('apps/tool-gateway-worker/wrangler.toml')).toContain('name = "SCRAPE_RATE_LIMITER"')
    expect(readRepoFile('apps/tool-gateway-worker/wrangler.toml')).toContain('STORYFLOW_TOOL_GATEWAY_JWT_CURRENT_PUBLIC_KEY')
    expect(readRepoFile('apps/tool-gateway-worker/wrangler.toml')).toContain('required = ["ANYSEARCH_API_KEY", "FIRECRAWL_API_KEY"]')
  })
})
