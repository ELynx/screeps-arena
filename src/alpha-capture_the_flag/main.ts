import { getObjectsByPrototype } from 'game/utils'
import { Creep, Position } from 'game/prototypes'
import { Flag } from 'arena/season_alpha/capture_the_flag/basic'

export function loop () {
  const enemyFlag = getObjectsByPrototype(Flag).find(object => !object.my)
  const myCreeps = getObjectsByPrototype(Creep).filter(object => object.my)
  for (const creep of myCreeps) {
    creep.moveTo(enemyFlag as Position)
  }
}
