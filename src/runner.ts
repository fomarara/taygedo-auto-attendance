import { parseAccountsSecret, type TaygedoAccount } from './config/accounts.js'
import { TaygedoApi } from './taygedo/api.js'
import { sendNotification } from './notify.js'
import { withRetries } from './utils/retry.js'
import { TAYGEDO_GAME_IDS } from './taygedo/games.js'

export interface RunnerDependencies {
  accountsSecret: string
  api?: Pick<TaygedoApi, 'refreshToken' | 'getGameRoles' | 'appSignin' | 'getSigninState' | 'getSigninRewards' | 'gameSignin'>
  notificationUrls?: string[]
  maxRetries?: number
  secretWriter?: (payload: string) => Promise<void>
}

export interface RunAttendanceResult {
  updatedAccounts: TaygedoAccount[]
  summary: string
}

interface AccountRunSummary {
  id: string
  name: string
  success: boolean
  appSignin?: {
    exp: number
    goldCoin: number
  }
  gameSignins: Array<{
    gameId: string
    roleName: string
    days?: number
    reward?: {
      name: string
      num: number
    }
    success: boolean
  }>
  error?: string
}

export async function runAttendance(deps: RunnerDependencies): Promise<RunAttendanceResult> {
  const accounts = parseAccountsSecret(deps.accountsSecret)
  const api = deps.api ?? new TaygedoApi()
  const updatedAccounts: TaygedoAccount[] = []
  let refreshedCount = 0
  const failedAccounts: string[] = []
  const accountSummaries: AccountRunSummary[] = []

  for (const account of accounts) {
    try {
      const accountRun = await withRetries(async () => {
        const refreshed = await api.refreshToken(account.refreshToken, account.deviceId)
        const gameRoles = await getAllGameRoles(api, refreshed.accessToken, account.uid, account.deviceId)
        const firstRole = gameRoles[0]
        const roleId = firstRole?.roleId ?? account.roleId

        const appSignin = await api.appSignin(refreshed.accessToken, account.uid, account.deviceId)
        const gameSignins: AccountRunSummary['gameSignins'] = []
        for (const role of gameRoles) {
          const signinState = await api.getSigninState(refreshed.accessToken, role.gameId)
          const signinRewards = await api.getSigninRewards(refreshed.accessToken, role.gameId)
          await api.gameSignin(refreshed.accessToken, role.roleId, role.gameId)
          gameSignins.push({
            gameId: role.gameId,
            roleName: role.roleName ?? role.roleId,
            days: signinState.days,
            reward: signinRewards[signinState.days - 1],
            success: true,
          })
        }

        const updated: TaygedoAccount = {
          ...account,
          refreshToken: refreshed.refreshToken,
        }
        if (roleId) {
          updated.roleId = roleId
        }
        if (firstRole?.roleName ?? account.roleName) {
          updated.roleName = firstRole?.roleName ?? account.roleName
        }
        return {
          updatedAccount: updated,
          summary: {
            id: account.id,
            name: account.name,
            success: true,
            appSignin,
            gameSignins,
          } satisfies AccountRunSummary,
        }
      }, deps.maxRetries ?? 3)

      refreshedCount++
      updatedAccounts.push(accountRun.updatedAccount)
      accountSummaries.push(accountRun.summary)
    }
    catch (error) {
      updatedAccounts.push({ ...account })
      failedAccounts.push(account.id)
      accountSummaries.push({
        id: account.id,
        name: account.name,
        success: false,
        gameSignins: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (refreshedCount > 0 && deps.secretWriter) {
    await deps.secretWriter(JSON.stringify(updatedAccounts, null, 2))
  }

  const summary = buildSummary(accountSummaries)
  console.log(summary)

  if (deps.notificationUrls?.length) {
    await sendNotification({
      urls: deps.notificationUrls,
      title: '塔吉多每日签到',
      content: summary,
    })
  }

  return {
    updatedAccounts,
    summary,
  }
}

async function getAllGameRoles(
  api: Pick<TaygedoApi, 'getGameRoles'>,
  accessToken: string,
  uid: string,
  deviceId: string,
): Promise<Array<{ gameId: string, roleId: string, roleName?: string }>> {
  const roles: Array<{ gameId: string, roleId: string, roleName?: string }> = []
  const seenRoleIds = new Set<string>()

  for (const gameId of TAYGEDO_GAME_IDS) {
    const gameRoleList = await api.getGameRoles(accessToken, uid, deviceId, gameId)
    for (const role of gameRoleList.roles) {
      if (!role.roleId || seenRoleIds.has(role.roleId)) {
        continue
      }
      seenRoleIds.add(role.roleId)
      roles.push({
        gameId,
        roleId: role.roleId,
        roleName: role.roleName,
      })
    }
  }

  return roles
}

function buildSummary(accounts: AccountRunSummary[]): string {
  const successCount = accounts.filter(account => account.success).length
  const failedCount = accounts.length - successCount
  const lines = [
    '塔吉多每日签到结果',
    `总账号：${accounts.length}，成功：${successCount}，失败：${failedCount}`,
    '',
  ]

  for (const account of accounts) {
    lines.push(`${account.name}（${account.id}）：${account.success ? '成功' : '失败'}`)
    if (account.appSignin) {
      lines.push(`- APP 签到：获得 ${account.appSignin.goldCoin} 金币，${account.appSignin.exp} 经验`)
    }
    for (const gameSignin of account.gameSignins) {
      const reward = gameSignin.reward ? `，奖励 ${gameSignin.reward.name} x${gameSignin.reward.num}` : ''
      const days = gameSignin.days === undefined ? '' : `，本月第 ${gameSignin.days} 天`
      lines.push(`- 游戏 ${gameSignin.gameId} / ${gameSignin.roleName}：签到成功${days}${reward}`)
    }
    if (account.error) {
      lines.push(`- 失败原因：${account.error}`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}
