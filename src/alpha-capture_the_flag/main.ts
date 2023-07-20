import { Direction, getDirection, getObjectsByPrototype, getTicks } from 'game/utils'
import { Creep, Position, Structure, StructureTower } from 'game/prototypes'
import { Flag } from 'arena/season_alpha/capture_the_flag/basic'
import { MOVE, RESOURCE_ENERGY, TOWER_ENERGY_COST } from 'game/constants'

let _flagCache: Flag[]
function allFlags(): Flag[] {
  if (_flagCache === undefined) {
    _flagCache = getObjectsByPrototype(Flag)
  }
  return _flagCache
}

let _towerCache: StructureTower[]
function allTowers(): StructureTower[] {
  if (_towerCache === undefined) {
    _towerCache = getObjectsByPrototype(StructureTower)
  }
  return _towerCache
}

let _creepCache: Creep[]
function allCreeps(): Creep[] {
  if (_creepCache === undefined) {
    _creepCache = getObjectsByPrototype(Creep)
  }
  return _creepCache
}

class PlayerInfo {
  flag: Flag | undefined
  towers: StructureTower[] = []
  creeps: Creep[] = []
}

class FlagGoal {
  flag: Flag | undefined
  creep: Creep | undefined
  pathfinding: boolean | undefined

  constructor(_flag: Flag, _creep: Creep, _pathfidning: boolean) {
    this.flag = _flag
    this.creep = _creep
    this.pathfinding = _pathfidning
  }
}

type Ownable = Flag | StructureTower | Creep

function fillPlayerInfo(whoFunction: (x: Ownable) => boolean): PlayerInfo {
  const playerInfo = new PlayerInfo()

  playerInfo.flag = allFlags().find(whoFunction)
  playerInfo.towers = allTowers().filter(whoFunction)
  playerInfo.creeps = allCreeps().filter(whoFunction)

  return playerInfo
}

let myPlayerInfo: PlayerInfo
let enemyPlayerInfo: PlayerInfo

let flagGoals: FlagGoal[]

export function loop(): void {
  if (getTicks() === 1) {
    myPlayerInfo = fillPlayerInfo(
      function my(what: Ownable): boolean {
        return what.my === true
      }
    )

    enemyPlayerInfo = fillPlayerInfo(
      function enemy(what: Ownable): boolean {
        return what.my === false
      }
    )

    for (const creep of myPlayerInfo.creeps) {
      if (creep.y === myPlayerInfo.flag.y) {
        flagGoals.push(new FlagGoal(myPlayerInfo.flag, creep, false))
      } else {
        flagGoals.push(new FlagGoal(enemyPlayerInfo.flag, creep, true))
      }
    }
  }

  play()
}

function exists(something?: Ownable) : boolean {
  if (something === undefined) return false
  if (something.exists === false) return false
  return true
}

function operational(something?: StructureTower | Creep) : boolean {
  if (!exists(something)) return false
  if (something.hits && something.hits <= 0) return false
  return true
}

function hasActiveBodyPart(creep: Creep, type: string) : boolean {
  return creep.body.some(
    function(value) : boolean {
      return value.type === this && value.hits > 0
    }
    , type
  )
}

function operateTower(tower: StructureTower): void {
  if (tower.cooldown > 0) return
  if (tower.store.getUsedCapacity(RESOURCE_ENERGY) < TOWER_ENERGY_COST) return

  // TODO
}

function atSamePosition(a: Position, b: Position) : boolean {
  return a.x === b.x && a.y === b.y
}

function getDirectionByPosition(from: Position, to: Position) : Direction | undefined {
  if (atSamePosition(from, to)) return undefined

  const dx = from.x - to.x
  const dy = from.y - to.y

  return getDirection(dx, dy)
}

function toFlagNoPathfinding(creep: Creep, flag: Flag ) : void {
  const direction = getDirectionByPosition(creep, flag)
  if (direction !== undefined) {
    creep.move(direction)
  }
}

function toFlagYesPathfinding(creep: Creep, flag: Flag) : void {
  creep.moveTo(flag)
}

function advanceFlagGoal(flagGoal: FlagGoal) {
  if (!exists(flagGoal.flag)) return

  if (!operational(flagGoal.creep)) return
  if (flagGoal.creep.fatigue > 0) return
  if (!hasActiveBodyPart(flagGoal.creep, MOVE)) return

  if (flagGoal.pathfinding) {
    toFlagYesPathfinding(flagGoal.creep, flagGoal.flag)
  } else {
    toFlagNoPathfinding(flagGoal.creep, flagGoal.flag)
  }
}

type Attackable = Creep | Structure
type Healable = Creep

function autoMelee(creep: Creep, attackables: Attackable[]) {
}

function autoRanged(creep: Creep, attackables: Attackable[]) {
}

function autoHeal(creep: Creep, healables: Healable[]) {
}

function autoAll(creep: Creep, attackables: Attackable[], healables: Healable[]) {
  autoMelee(creep, attackables)
  autoRanged(creep, attackables)
  autoHeal(creep, healables)
}

function play(): void {
  flagGoals.forEach(advanceFlagGoal)

  myPlayerInfo.towers.filter(operational).forEach(operateTower)

  let myCreeps = myPlayerInfo.creeps.filter(operational)

  let enemyCreeps = enemyPlayerInfo.creeps.filter(operational)
  let enemyTowers = enemyPlayerInfo.towers.filter(operational)
  let enemyAttackables = (enemyCreeps as Attackable[]).concat(enemyTowers as Attackable[])

  myCreeps.forEach(
    function(creep, index, localMyCreeps) : void {
      autoAll(creep, this, localMyCreeps)
    }, enemyAttackables
  )
}
