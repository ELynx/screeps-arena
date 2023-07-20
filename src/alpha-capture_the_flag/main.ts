import { getObjectsByPrototype, getTicks } from 'game/utils'
import { Creep, Position, StructureTower } from 'game/prototypes'
import { Flag } from 'arena/season_alpha/capture_the_flag/basic'

let _flagCache: Flag[]
let _towerCache: StructureTower[]
let _creepCache: Creep[]

function _fillCaches () {
  if (_flagCache === undefined) {
    _flagCache = getObjectsByPrototype(Flag)
  }

  if (_towerCache === undefined) {
    _towerCache = getObjectsByPrototype(StructureTower)
  }

  if (_creepCache === undefined) {
    _creepCache = getObjectsByPrototype(Creep)
  }
}

class PlayerInfo {
  flag: Flag | undefined

  tower1: StructureTower | undefined
  tower2: StructureTower | undefined

  creeps: Creep[] = []
}

function fillPlayerInfo (whoFunction: Function) : PlayerInfo {
  _fillCaches()

  const playerInfo = new PlayerInfo()

  playerInfo.flag = _flagCache.find(x => whoFunction.apply(x))

  const towers = _towerCache.filter(x => whoFunction.apply(x))
  if (towers.length > 0) playerInfo.tower1 = towers[0]
  if (towers.length > 1) playerInfo.tower2 = towers[1]

  playerInfo.creeps = _creepCache.filter(x => whoFunction.apply(x))

  return playerInfo
}

let myPlayerInfo : PlayerInfo
let enemyPlayerInfo : PlayerInfo

export function loop () {
  if (getTicks() === 1) {
    myPlayerInfo = fillPlayerInfo(
      function my (what: Flag | StructureTower | Creep) : boolean {
        return what.my === true
      }
    )

    enemyPlayerInfo = fillPlayerInfo(
      function enemy (what: Flag | StructureTower | Creep) : boolean {
        return what.my === false
      }
    )
  }

  for (const creep of myPlayerInfo.creeps) {
    creep.moveTo(enemyPlayerInfo.flag as Position)
  }
}
