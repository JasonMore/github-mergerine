import { resolve } from 'path'
import { readFileSync } from 'fs'

const {
  MERGERINE_CONFIG = 'mergerine.json',
  MERGERINE_INTERVAL,
  MERGERINE_DELETE_BRANCH_AFTER_MERGE,
  MERGERINE_DRY,
  MERGERINE_GITHUB_TOKEN,
  GITHUB_TOKEN
} = process.env

const config = JSON.parse(
  readFileSync(resolve(process.cwd(), MERGERINE_CONFIG), 'utf8')
)

const token = MERGERINE_GITHUB_TOKEN || GITHUB_TOKEN || config.token

const interval = parseInt(MERGERINE_INTERVAL) || config.interval || 120000 // 2 minutes

const deleteBranchAfterMerge =
  MERGERINE_DELETE_BRANCH_AFTER_MERGE === 'true' ||
  config.deleteBranchAfterMerge

const dry = MERGERINE_DRY === 'true' || config.dry

export { config, token, interval, deleteBranchAfterMerge, dry }
