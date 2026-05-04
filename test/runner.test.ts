import { describe, expect, it, vi } from 'vitest'
import { runAttendance } from '../src/runner.js'

describe('runAttendance', () => {
  it('keeps failed account refresh tokens unchanged in the updated secret payload', async () => {
    const secretWriter = vi.fn()
    const api = {
      refreshToken: vi.fn()
        .mockResolvedValueOnce({ accessToken: 'access-main', refreshToken: 'new-main' })
        .mockRejectedValueOnce(new Error('expired')),
      getGameRoles: vi.fn().mockResolvedValue({ roles: [{ roleId: 'role-1', roleName: '角色一' }] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          refreshToken: 'old-main',
        },
        {
          id: 'alt',
          name: '备用账号',
          uid: '2',
          deviceId: 'device-2',
          refreshToken: 'old-alt',
        },
      ]),
      api,
      notificationUrls: [],
      maxRetries: 1,
      secretWriter,
    })

    expect(result.updatedAccounts).toEqual([
      {
        id: 'main',
        name: '主账号',
        uid: '1',
        deviceId: 'device-1',
        refreshToken: 'new-main',
        roleId: 'role-1',
        roleName: '角色一',
      },
      {
        id: 'alt',
        name: '备用账号',
        uid: '2',
        deviceId: 'device-2',
        refreshToken: 'old-alt',
      },
    ])
    expect(secretWriter).toHaveBeenCalledWith(JSON.stringify(result.updatedAccounts, null, 2))
  })

  it('does not write the secret when every account fails before refresh completes', async () => {
    const secretWriter = vi.fn()
    const api = {
      refreshToken: vi.fn().mockRejectedValue(new Error('expired')),
      getGameRoles: vi.fn(),
      appSignin: vi.fn(),
      getSigninState: vi.fn(),
      getSigninRewards: vi.fn(),
      gameSignin: vi.fn(),
    }

    await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          refreshToken: 'old-main',
        },
      ]),
      api,
      secretWriter,
    })

    expect(secretWriter).not.toHaveBeenCalled()
  })

  it('retries transient account failures before marking an account failed', async () => {
    const api = {
      refreshToken: vi.fn()
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValueOnce({ accessToken: 'access-main', refreshToken: 'new-main' }),
      getGameRoles: vi.fn().mockResolvedValue({ roles: [{ roleId: 'role-1', roleName: '角色一' }] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          refreshToken: 'old-main',
        },
      ]),
      api,
      maxRetries: 2,
    })

    expect(api.refreshToken).toHaveBeenCalledTimes(2)
    expect(result.updatedAccounts[0]?.refreshToken).toBe('new-main')
  })

  it('signs all known games for each account', async () => {
    const api = {
      refreshToken: vi.fn().mockResolvedValue({ accessToken: 'access-main', refreshToken: 'new-main' }),
      getGameRoles: vi.fn()
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1256-a', roleName: '幻塔A' }] })
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1257-a', roleName: '异环A' }] })
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1289-a', roleName: '第三游戏A' }] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          refreshToken: 'old-main',
        },
      ]),
      api,
      maxRetries: 1,
    })

    expect(api.getGameRoles).toHaveBeenCalledTimes(3)
    expect(api.gameSignin).toHaveBeenCalledTimes(3)
    expect(api.gameSignin).toHaveBeenNthCalledWith(1, 'access-main', 'role-1256-a', '1256')
    expect(api.gameSignin).toHaveBeenNthCalledWith(2, 'access-main', 'role-1257-a', '1257')
    expect(api.gameSignin).toHaveBeenNthCalledWith(3, 'access-main', 'role-1289-a', '1289')
    expect(result.updatedAccounts[0]?.roleId).toBe('role-1256-a')
    expect(result.updatedAccounts[0]?.roleName).toBe('幻塔A')
  })

  it('builds a readable Chinese summary with account rewards and game rewards', async () => {
    const api = {
      refreshToken: vi.fn().mockResolvedValue({ accessToken: 'access-main', refreshToken: 'new-main' }),
      getGameRoles: vi.fn()
        .mockResolvedValueOnce({ roles: [{ roleId: 'role-1256-a', roleName: '幻塔A' }] })
        .mockResolvedValueOnce({ roles: [] })
        .mockResolvedValueOnce({ roles: [] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '墨晶', num: 5 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    const result = await runAttendance({
      accountsSecret: JSON.stringify([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          refreshToken: 'old-main',
        },
      ]),
      api,
      maxRetries: 1,
    })

    expect(result.summary).toContain('塔吉多每日签到结果')
    expect(result.summary).toContain('总账号：1，成功：1，失败：0')
    expect(result.summary).toContain('主账号（main）：成功')
    expect(result.summary).toContain('APP 签到：获得 20 金币，10 经验')
    expect(result.summary).toContain('游戏 1256 / 幻塔A：签到成功，本月第 1 天，奖励 墨晶 x5')
  })
})
