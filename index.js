'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const API_HOST = 'api.mushasec.com'

function getInput(name) {
  const v = process.env['INPUT_' + name.toUpperCase().replace(/ /g, '_')]
  return v === undefined ? '' : v.trim()
}
function info(msg) {
  process.stdout.write(msg + '\n')
}
function setFailed(msg) {
  process.stdout.write('::error::' + msg + '\n')
  process.exitCode = 1
}

async function getIdToken(audience) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const reqTok = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!url || !reqTok) {
    throw new Error(
      'OIDC is not available. Add this to the job:\n' +
        '  permissions:\n    id-token: write\n    contents: read',
    )
  }
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { Authorization: `Bearer ${reqTok}` },
  })
  if (!res.ok) throw new Error(`Could not obtain an OIDC token (HTTP ${res.status}).`)
  const body = await res.json()
  if (!body.value) throw new Error('GitHub returned an empty OIDC token.')
  return body.value
}

function prId() {
  const evPath = process.env.GITHUB_EVENT_PATH
  if (evPath) {
    try {
      const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'))
      if (ev.pull_request && ev.pull_request.number) return String(ev.pull_request.number)
    } catch {}
  }
  return ''
}

function parseAddedLines(diff) {
  const result = {}
  let current = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim()
      current = p === '/dev/null' ? null : p.replace(/^b\//, '')
    } else if (current && line.startsWith('@@')) {
      const m = line.match(/\+(\d+)(?:,(\d+))?/)
      if (!m) continue
      const start = parseInt(m[1], 10)
      const count = m[2] === undefined ? 1 : parseInt(m[2], 10)
      if (count === 0) continue
      ;(result[current] ||= []).push([start, start + count - 1])
    }
  }
  return Object.keys(result).length ? result : null
}

function computeAddedLines() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return null
  const base = process.env.GITHUB_BASE_REF
  if (!base) return null
  try {
    execFileSync('git', ['fetch', '--no-tags', '--quiet', 'origin', base], { stdio: 'ignore' })
  } catch {
  }
  try {
    const diff = execFileSync(
      'git',
      ['diff', '--unified=0', '--no-color', `origin/${base}...HEAD`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    return parseAddedLines(diff)
  } catch (e) {
    info(
      '::warning::Could not compute the PR diff; scanning without diff-only ' +
        'filtering (pre-existing findings may be reported). Add `fetch-depth: 0` ' +
        'to actions/checkout for diff-aware PR scans. ' +
        (e && e.message ? e.message : ''),
    )
    return null
  }
}

async function main() {
  const projectId = getInput('project-id')
  if (!projectId) throw new Error('Missing required input: project-id')
  const base = `https://${API_HOST}`
  const repo = process.env.GITHUB_REPOSITORY

  info('Requesting GitHub OIDC token...')
  const oidc = await getIdToken(API_HOST)

  info('Exchanging it for a Musha CI token...')
  const tokenRes = await fetch(`${base}/v1/ci/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'github', token: oidc }),
  })
  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '')
    if (tokenRes.status === 401 || tokenRes.status === 403) {
      throw new Error(
        `Musha rejected the OIDC token (HTTP ${tokenRes.status}). ` +
          `Make sure "${repo}" is connected to this project in the Musha Integration Guide.`,
      )
    }
    throw new Error(`Token exchange failed (HTTP ${tokenRes.status}). ${detail}`)
  }
  const { token } = await tokenRes.json()
  if (!token) throw new Error('Token exchange returned no token.')

  info('Packaging the repository...')
  const tarPath = path.join(process.env.RUNNER_TEMP, 'musha-scan.tar.gz')
  execFileSync(
    'tar',
    ['-czf', tarPath, '--exclude=.git', '--exclude=node_modules', '.'],
    { stdio: 'inherit' },
  )

  const MAX_TAR_BYTES = 49 * 1024 * 1024
  const tarBytes = fs.statSync(tarPath).size
  if (tarBytes > MAX_TAR_BYTES) {
    throw new Error(
      `Repository archive is ${(tarBytes / 1024 / 1024).toFixed(1)} MB, over Musha's ` +
        `49 MB limit. Exclude build output, binaries, or large fixtures ` +
        `(.git and node_modules are already excluded).`,
    )
  }

  const addedLines = computeAddedLines()

  info('Uploading to Musha and scanning...')
  const form = new FormData()
  form.set('project_id', projectId)
  form.set('scan_type', 'full')
  form.set('branch', process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME)
  form.set('pr_id', prId())
  form.set('commit_hash', process.env.GITHUB_SHA)
  if (addedLines) {
    form.set('added_lines', JSON.stringify(addedLines))
    info(`Diff-aware scan: ${Object.keys(addedLines).length} changed file(s).`)
  }
  form.set('files', new Blob([fs.readFileSync(tarPath)]), 'scan.tar.gz')

  const scanRes = await fetch(`${base}/v1/scans`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: form,
  })
  const out = await scanRes.json().catch(() => ({}))
  if (!scanRes.ok) {
    throw new Error(`Scan failed (HTTP ${scanRes.status}): ${out.error || 'unknown error'}`)
  }

  const sb = out.severity_breakdown || {}
  info('')
  info(`Scan ${out.scan_id} - ${out.findings_count ?? 0} finding(s)`)
  info(
    `  critical ${sb.critical ?? 0}  high ${sb.high ?? 0}  ` +
      `medium ${sb.medium ?? 0}  low ${sb.low ?? 0}  info ${sb.info ?? 0}`,
  )
  if (out.scan_id) info(`  https://app.mushasec.com/scans/${out.scan_id}`)
  info('')

  if (out.blocked) {
    setFailed('Scan blocked by your Musha SLA policy - see the findings above.')
  }
}

if (require.main === module) {
  main().catch((e) => setFailed(e && e.message ? e.message : String(e)))
}

module.exports = { parseAddedLines, computeAddedLines }
