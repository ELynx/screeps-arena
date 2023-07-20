import { Direction, getDirection, getObjectsByPrototype, getRange, getTicks } from 'game/utils'
import { Creep, GameObject, Position, Structure, StructureTower } from 'game/prototypes'
import { Flag } from 'arena/season_alpha/capture_the_flag/basic'
import { ATTACK, MOVE, RANGED_ATTACK, RANGED_ATTACK_DISTANCE_RATE, RANGED_ATTACK_POWER, RESOURCE_ENERGY, TOWER_ENERGY_COST } from 'game/constants'

function sortById(a: GameObject, b: GameObject) : number {
  return a.id.toString().localeCompare(b.id.toString())
}

let _flagCache: Flag[]
function allFlags(): Flag[] {
  if (_flagCache === undefined) {
    _flagCache = getObjectsByPrototype(Flag).sort(sortById)
  }
  return _flagCache
}

let _towerCache: StructureTower[]
function allTowers(): StructureTower[] {
  if (_towerCache === undefined) {
    _towerCache = getObjectsByPrototype(StructureTower).sort(sortById)
  }
  return _towerCache
}

let _creepCache: Creep[]
function allCreeps(): Creep[] {
  if (_creepCache === undefined) {
    _creepCache = getObjectsByPrototype(Creep).sort(sortById)
  }
  return _creepCache
}

class PlayerInfo {
  flag: Flag | undefined
  towers: StructureTower[] = []
  creeps: Creep[] = []
}

type Ownable = Flag | StructureTower | Creep

function fillPlayerInfo(whoFunction: (x: Ownable) => boolean): PlayerInfo {
  const playerInfo = new PlayerInfo()

  playerInfo.flag = allFlags().find(whoFunction)
  playerInfo.towers = allTowers().filter(whoFunction)
  playerInfo.creeps = allCreeps().filter(whoFunction)

  return playerInfo
}

class FlagGoal {
  creep: Creep
  flag: Flag
  pathfinding: boolean

  constructor(creep: Creep, flag: Flag, pathfidning: boolean) {
    this.creep = creep
    this.flag = flag
    this.pathfinding = pathfidning
  }
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
        flagGoals.push(new FlagGoal(creep, myPlayerInfo.flag, false))
      } else {
        flagGoals.push(new FlagGoal(creep, enemyPlayerInfo.flag, true))
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
    function(bodyPart) : boolean {
      return bodyPart.hits > 0 && bodyPart.type === this
    }
    , type
  )
}

function notMaxHits(creep: Creep) : boolean {
  return creep.hits < creep.hitsMax
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

function autoMelee(creep: Creep, attackables: Attackable[]) {
  if (!hasActiveBodyPart(creep, ATTACK)) return

  let inRange = creep.findInRange(attackables, 1)
  if (inRange.length > 0) {
    creep.attack(inRange[0])
  }
}

class AttackableAndRange {
  attackable: Attackable
  range: number

  constructor (attackable: Attackable, range: number) {
    this.attackable = attackable
    this.range = range
  }
}

function rangedMassAttackPower(target: AttackableAndRange) : number {
  return RANGED_ATTACK_POWER * (RANGED_ATTACK_DISTANCE_RATE[target.range] || 0)
}

function autoRanged(creep: Creep, attackables: Attackable[]) {
  if (!hasActiveBodyPart(creep, RANGED_ATTACK)) return

  let inRange = attackables.map(
    function(target: Attackable) : AttackableAndRange {
      let range = getRange(this, target)
      return new AttackableAndRange(target, range)
    }, creep
  ).filter(
    function(target: AttackableAndRange) : boolean {
      return target.range <= 3
    }
  )

  if (inRange.length === 0) return

  let totalMassAttackPower = inRange.map(rangedMassAttackPower).reduce((sum, current) => sum + current, 0)

  if (totalMassAttackPower >= RANGED_ATTACK_POWER) {
    creep.rangedMassAttack()
  } else {
    creep.rangedAttack(inRange[0].attackable)
  }
}

function autoHeal(creep: Creep, healables: Creep[]) {
}

function autoAll(creep: Creep, attackables: Attackable[], healables: Creep[]) {
  autoMelee(creep, attackables)
  autoRanged(creep, attackables)
  autoHeal(creep, healables)
}

function play(): void {
  flagGoals.forEach(advanceFlagGoal)

  myPlayerInfo.towers.filter(operational).forEach(operateTower)

  let enemyCreeps = enemyPlayerInfo.creeps.filter(operational)
  let enemyTowers = enemyPlayerInfo.towers.filter(operational)
  let enemyAttackables = (enemyCreeps as Attackable[]).concat(enemyTowers as Attackable[])

  let myCreeps = myPlayerInfo.creeps.filter(operational)
  let myHealableCreeps = myCreeps.filter(notMaxHits)

  let context = {
    enemyAttackables,
    myHealableCreeps
  }

  myCreeps.forEach(
    function(creep) : void {
      autoAll(creep, this.enemyAttackables, this.myHealableCreeps)
    }, context
  )
}
