import { sortBy } from 'lodash'
import githubFetch, { repoFetch } from './fetch'
import log, { logDecide, trace } from './log'

const isUserInTeam = async (login, team) => {
  try {
    const url = team.members_url.replace('{/member}', `/${login}`)
    trace('DEV USER IN TEAM', { login, team, url })
    return await githubFetch(url)
  } catch (err) {
    trace(err)
    // TODO: 404 is expected, but what about other non-404 errors, e.g., 5XX?
    return false
  }
}

const isUserInUsers = (login, users) => users.some(user => user.login === login)

const isUserInTeams = async (pull, login, teams) => {
  for (let team of teams) {
    if (await isUserInTeam(login, team)) {
      logDecide(`${pull.number} allows user "${login}" in team "${team.name}"`)
      return true
    }
  }

  logDecide(`${pull.number} has no user "${login}" in teams`)

  return false
}

const isUserInUsersOrTeams = async (pull, login, users, teams) => {
  const userIsInUsers = isUserInUsers(login, users)
  if (userIsInUsers) {
    logDecide(`${pull.number} allows user "${login}" in users`)
    return true
  }

  return isUserInTeams(pull, login, teams)
}

const isUserAllowedToMerge = (login, pull, restrictions) => {
  if (!restrictions) {
    // TODO: Handle no restrictions.
    logDecide(`${pull.number} has no restrictions for user "${login}"`)
    return true
  }

  const { users, teams = [] } = restrictions

  return isUserInUsersOrTeams(pull, login, users, teams)
}

const isLabelInLabels = (name, labels) =>
  labels.some(label => label.name === name)

const everyLabelInLabels = (labels, requireds) =>
  requireds.every(label => isLabelInLabels(label, labels))

const someLabelInLabels = (labels, candidates) =>
  candidates.some(label => isLabelInLabels(label, labels))

const fetchLabels = async (pull, options) => {
  const labelsUrl = `${pull.url.replace('/pulls/', '/issues/')}/labels`
  const { data: labels } = await githubFetch(labelsUrl)
  return labels
}

const isMergeableByLabels = async (pull, options) => {
  // TODO: Does this shorthand work to get labels on `pull` itself from a search (not a pulls list)?
  const labels = pull.labels || (await fetchLabels(pull, options))
  logDecide(pull.number, 'labels', labels, 'vs. expected', options.labels)
  if (
    (options.labels && !everyLabelInLabels(labels, options.labels)) ||
    (options.notLabels && someLabelInLabels(labels, options.notLabels))
  ) {
    return false
  }
  return true
}

const getRestrictions = async (pull, options) => {
  const { base: { ref: baseRef } } = pull
  try {
    const { data: restrictions } = await repoFetch(
      `/branches/${baseRef}/protection/restrictions`,
      options
    )
    return restrictions
  } catch (err) {
    trace(err)
    // TODO: 404 is expected, but what about other non-404 errors, e.g., 5XX?
  }
}

const isMergeableByReviews = async (pull, options) => {
  const reviewsUrl = `${pull.url}/reviews`
  const { data: reviews } = await githubFetch(reviewsUrl)
  if (!reviews || !reviews.length) {
    logDecide(`${pull.number} has no reviews`)
    return false
  }

  const approvals = reviews.filter(({ state }) => state === 'APPROVED')
  if (!approvals || !approvals.length) {
    logDecide(`${pull.number} has no approvals`)
    return false
  }

  const changesRequesteds = reviews.filter(
    ({ state }) => state === 'CHANGES_REQUESTED'
  )

  if (changesRequesteds && changesRequesteds.length) {
    const areChangesRequestedsReplacedByApprovals = changesRequesteds.every(
      changesRequested => {
        // TODO: Test the structure of approvals user.
        const approvalsByUser = approvals.filter(
          approval => approval.user.login === changesRequested.user.login
        )
        // Be sure it was approved more recently than changes were requested.
        return approvalsByUser.some(
          approval => approval.submitted_at > changesRequested.submitted_at
        )
      }
    )

    if (areChangesRequestedsReplacedByApprovals) {
      logDecide(
        `${
          pull.number
        } has changes requested but are replaced by later approvals from same users`
      )
    } else {
      logDecide(
        `${
          pull.number
        } has changes requested that are not replaced by later approvals from same users`
      )
      return false
    }
  }

  const restrictions = await getRestrictions(pull, options)

  if (restrictions) {
    for (let approval of approvals) {
      const { user: { login } } = approval

      const userIsAllowedToMerge = await isUserAllowedToMerge(
        login,
        pull,
        restrictions
      )

      if (userIsAllowedToMerge) {
        return true
      }
    }

    return false
  }

  return true
}

const isMergeableByLabelsAndReviews = async (pull, options) => {
  // TODO: See if we should even auto-merge to the given branch, per configuration.

  // TODO: Bypass this labels check if we're not configured to care about labels,
  //  or if assumed optional based on search query rules.
  if (!await isMergeableByLabels(pull, options)) {
    logDecide(`${pull.number} is not mergeable by labels`)
    return false
  }

  // TODO: Bypass this if the branch isn't protected with approval requirement.
  if (!await isMergeableByReviews(pull, options)) {
    logDecide(`${pull.number} is not mergeable by reviews`)
    return false
  }

  return true
}

const relevantMergeableStates = ['clean', 'behind']

const hasRelevantMergeableState = pull =>
  relevantMergeableStates.includes(pull.mergeable_state)

const isClosed = pull => pull.state !== 'open' || pull.merged

const shouldMerge = async (pull, options) => {
  if (isClosed(pull)) {
    logDecide(`${pull.number} is closed, not merging`)
    return false
  }

  if (pull.mergeable_state !== 'clean') {
    logDecide(`${pull.number} is not clean, not merging`)
    return false
  }

  return isMergeableByLabelsAndReviews(pull, options)
}

const shouldUpdate = async (pull, options) => {
  if (isClosed(pull)) {
    logDecide(`${pull.number} is closed, not updating`)
    return false
  }

  if (pull.mergeable_state !== 'behind') {
    logDecide(`${pull.number} is not behind, not updating`)
    return false
  }

  return isMergeableByLabelsAndReviews(pull, options)
}

const shouldSkip = pull => isClosed(pull) || !hasRelevantMergeableState(pull)

const decideForPull = async (pull, options) => {
  const result = { pull }
  const results = [result]

  if (await shouldMerge(pull, options)) {
    return {
      action: 'merge',
      result,
      results,
      options
    }
  }

  if (await shouldUpdate(pull, options)) {
    return {
      action: 'decide',
      result,
      results,
      options
    }
  }

  return { action: 'wait', result, results, options }
}

const decideWithResults = async (results, options) => {
  // TODO: Custom sort strategies? Priorities? Etc.
  results = sortBy(results, result => result.pull.number)

  logDecide('results', results.map(r => r.pull.number).join(','))

  for (let result of results) {
    if (await shouldMerge(result.pull, options)) {
      return { action: 'merge', result, results, options }
    }
  }

  // Since none were mergeable, find one to update:

  for (let result of results) {
    if (await shouldUpdate(result.pull, options)) {
      return { action: 'update', result, results, options }
    }
  }

  return { action: 'wait', options }
}

const decideWithPulls = (pulls, options) =>
  decideWithResults(pulls.map(pull => ({ pull })), options)

const fetchPulls = async ({ baseUrl, owner, name, pullsMode, query }) => {
  let pulls
  if (pullsMode === 'search') {
    try {
      const { data } = await githubFetch(
        `${baseUrl}/search/issues?q=${encodeURIComponent(query)}`
      )
      log({ searchData: data })
      pulls = data.items
    } catch (err) {
      trace(err)
      // TODO: Detect if it's fatal or not.
    }
  } else {
    try {
      const { data } = await githubFetch(
        `${baseUrl}/repos/${owner}/${name}/pulls`
      )
      log({ listData: data })
      pulls = data.filter(shouldSkip)
    } catch (err) {
      trace(err)
      // TODO: Detect if it's fatal or not.
    }
  }

  log({ pulls })

  return pulls
}

const decide = async options => {
  const {
    baseUrl, // e.g. 'https://api.github.com' or https://github.example.com/api/v3'
    owner, // repo user or org
    name, // repo name
    query,
    pullsMode = query ? 'search' : 'list' // whether to use list or search for pulls
  } = options

  // For search instead of list:
  //
  // 'review:approved' seems to filter out any PRs with changes requested, even if they also have approvals.
  //
  //   'is:pr is:open review:approved label:merge -label:"no merge" base:master'
  //
  //  'status:success' seems to exclude PRs that are simply behind base, so we'll not use that

  const pulls = await fetchPulls({ baseUrl, owner, name, pullsMode, query })

  if (!pulls || !pulls.length) return { action: 'wait' }

  const fullPulls = []
  for (let pull of pulls) {
    try {
      const url = `${baseUrl}/repos/${owner}/${name}/pulls/${pull.number}`

      const response = await githubFetch(url)

      const { data: fullPull } = response

      log({ pullNum: pull.number, response, fullPull })

      // carry over labels from search results, since full pull doesn't have
      fullPull.labels = pull.labels

      fullPulls.push(fullPull)
    } catch (err) {
      trace(err)
    }
  }

  return decideWithPulls(fullPulls, options)
}

export { shouldMerge, shouldUpdate, decideForPull }

export default decide
