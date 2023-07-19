import { getTicks } from 'game/utils'

export function loop (): void {
  console.log('Current tick: ', getTicks())
}
