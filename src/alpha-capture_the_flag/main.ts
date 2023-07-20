import { getObjectsByPrototype, getTicks } from 'game/utils'
import { Creep, Position, StructureTower } from 'game/prototypes'
import { Flag } from 'arena/season_alpha/capture_the_flag/basic'

let _flagCache: Flag[]
function allFlags() : Flag[] {
  if (_flagCache === undefined) {
    _flagCache = getObjectsByPrototype(Flag)
  }
  return _flagCache
}

let _towerCache: StructureTower[]
function allTowers() : StructureTower[] {
  if (_towerCache === undefined) {
    _towerCache = getObjectsByPrototype(StructureTower)
  }
  return _towerCache
}

let _creepCache: Creep[]
function allCreeps() : Creep[] {
  if (_creepCache === undefined) {
    _creepCache = getObjectsByPrototype(Creep)
  }
  return _creepCache
}

class PlayerInfo {
  flag: Flag | undefined

  tower1: StructureTower | undefined
  tower2: StructureTower | undefined

  creeps: Creep[] = []
}

type Ownable = Flag | StructureTower | Creep

function fillPlayerInfo (whoFunction: (x: Ownable) => boolean) : PlayerInfo {
  const playerInfo = new PlayerInfo()

  playerInfo.flag = allFlags().find(x => whoFunction.apply(x))

  const towers = allTowers().filter(x => whoFunction.apply(x))
  if (towers.length > 0) playerInfo.tower1 = towers[0]
  if (towers.length > 1) playerInfo.tower2 = towers[1]

  playerInfo.creeps = allCreeps().filter(x => whoFunction.apply(x))

  return playerInfo
}

let myPlayerInfo : PlayerInfo
let enemyPlayerInfo : PlayerInfo

export function loop () {
  if (getTicks() === 1) {
    myPlayerInfo = fillPlayerInfo(
      function my (what: Ownable) : boolean {
        return what.my === true
      }
    )

    enemyPlayerInfo = fillPlayerInfo(
      function enemy (what: Ownable) : boolean {
        return what.my === false
      }
    )
  }

  for (const creep of myPlayerInfo.creeps) {
    creep.moveTo(enemyPlayerInfo.flag as Position)
  }
}
