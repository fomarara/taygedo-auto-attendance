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

export async function runAttendance(deps: RunnerDependencies): Promise<RunAttendanceResult> {
  const accounts = parseAccountsSecret(deps.accountsSecret)
  const api = deps.api ?? new TaygedoApi()
  const updatedAccounts: TaygedoAccount[] = []
  let refreshedCount = 0
  const failedAccounts: string[] = []

  for (const account of accounts) {
    try {
      const updatedAccount = await withRetries(async () => {
        const refreshed = await api.refreshToken(account.refreshToken, account.deviceId)
        const gameRoles = await getAllGameRoles(api, refreshed.accessToken, account.uid, account.deviceId)
        const firstRole = gameRoles[0]
        const roleId = firstRole?.roleId ?? account.roleId

        await api.appSignin(refreshed.accessToken, account.uid, account.deviceId)
        for (const role of gameRoles) {
          await api.getSigninState(refreshed.accessToken, role.gameId)
          await api.getSigninRewards(refreshed.accessToken, role.gameId)
          await api.gameSignin(refreshed.accessToken, role.roleId, role.gameId)
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
        return updated
      }, deps.maxRetries ?? 3)

      refreshedCount++
      updatedAccounts.push(updatedAccount)
    }
    catch {
      updatedAccounts.push({ ...account })
      failedAccounts.push(account.id)
    }
  }

  if (refreshedCount > 0 && deps.secretWriter) {
    await deps.secretWriter(JSON.stringify(updatedAccounts, null, 2))
  }

  if (deps.notificationUrls?.length) {
    await sendNotification({
      urls: deps.notificationUrls,
      title: '塔吉多每日签到',
      content: buildSummary(updatedAccounts, failedAccounts),
    })
  }

  return {
    updatedAccounts,
    summary: buildSummary(updatedAccounts, failedAccounts),
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

function buildSummary(updatedAccounts: TaygedoAccount[], failedAccounts: string[]): string {
  return JSON.stringify({
    total: updatedAccounts.length,
    failedAccounts,
  }, null, 2)
}
