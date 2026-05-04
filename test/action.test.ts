import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/action.js'

describe('runAction', () => {
  it('writes updated accounts json to the configured output path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'taygedo-action-'))
    const outputPath = join(dir, 'updated-accounts.json')
    const api = {
      refreshToken: vi.fn().mockResolvedValue({ accessToken: 'access-main', refreshToken: 'new-main' }),
      getGameRoles: vi.fn().mockResolvedValue({ roles: [{ roleId: 'role-1', roleName: '角色一' }] }),
      appSignin: vi.fn().mockResolvedValue({ exp: 10, goldCoin: 20 }),
      getSigninState: vi.fn().mockResolvedValue({ days: 1 }),
      getSigninRewards: vi.fn().mockResolvedValue([{ name: '奖励一', num: 1 }]),
      gameSignin: vi.fn().mockResolvedValue(undefined),
    }

    try {
      await runAction({
        env: {
          TAYGEDO_ACCOUNTS: JSON.stringify([
            {
              id: 'main',
              name: '主账号',
              uid: '1',
              deviceId: 'device-1',
              refreshToken: 'old-main',
            },
          ]),
          TAYGEDO_UPDATED_ACCOUNTS_PATH: outputPath,
        },
        api,
      })

      expect(JSON.parse(await readFile(outputPath, 'utf8'))).toEqual([
        {
          id: 'main',
          name: '主账号',
          uid: '1',
          deviceId: 'device-1',
          refreshToken: 'new-main',
          roleId: 'role-1',
          roleName: '角色一',
        },
      ])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
