import { Direction, getDirection, getObjectsByPrototype, getRange, getTicks } from 'game/utils'
import { Creep, GameObject, Position, Structure, StructureTower } from 'game/prototypes'
import { Flag } from 'arena/season_alpha/capture_the_flag/basic'
import { ATTACK, HEAL, MOVE, RANGED_ATTACK, RANGED_ATTACK_DISTANCE_RATE, RANGED_ATTACK_POWER, RESOURCE_ENERGY, TOWER_ENERGY_COST, TOWER_FALLOFF, TOWER_FALLOFF_RANGE, TOWER_OPTIMAL_RANGE, TOWER_POWER_ATTACK, TOWER_POWER_HEAL, TOWER_RANGE } from 'game/constants'
import { Visual } from 'game/visual'

function sortById (a: GameObject, b: GameObject) : number {
  return a.id.toString().localeCompare(b.id.toString())
}

let _flagCache: Flag[]
function allFlags (): Flag[] {
  if (_flagCache === undefined) {
    _flagCache = getObjectsByPrototype(Flag).sort(sortById)
  }
  return _flagCache
}

let _towerCache: StructureTower[]
function allTowers (): StructureTower[] {
  if (_towerCache === undefined) {
    _towerCache = getObjectsByPrototype(StructureTower).sort(sortById)
  }
  return _towerCache
}

let _creepCache: Creep[]
function allCreeps (): Creep[] {
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

function fillPlayerInfo (whoFunction: (x: Ownable) => boolean): PlayerInfo {
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

  constructor (creep: Creep, flag: Flag, pathfidning: boolean) {
    this.creep = creep
    this.flag = flag
    this.pathfinding = pathfidning
  }
}

let myPlayerInfo: PlayerInfo
let enemyPlayerInfo: PlayerInfo
let flagGoals: FlagGoal[]
let engageDistance: number

export function loop (): void {
  if (getTicks() === 1) {
    myPlayerInfo = fillPlayerInfo(
      function my (what: Ownable): boolean {
        return what.my === true
      }
    )

    enemyPlayerInfo = fillPlayerInfo(
      function enemy (what: Ownable): boolean {
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

    engageDistance = getRange(myPlayerInfo.flag, enemyPlayerInfo.flag)
  }

  play()
}

function exists (something?: Ownable) : boolean {
  if (something === undefined) return false
  if (something.exists === false) return false
  return true
}

function operational (something?: StructureTower | Creep) : boolean {
  if (!exists(something)) return false
  if (something.hits && something.hits <= 0) return false
  return true
}

function hasActiveBodyPart (creep: Creep, type: string) : boolean {
  return creep.body.some(
    function (bodyPart) : boolean {
      return bodyPart.hits > 0 && bodyPart.type === this
    }
    , type
  )
}

function notMaxHits (creep: Creep) : boolean {
  return creep.hits < creep.hitsMax
}

class StructureTowerScore {
  creep: Creep
  range: number
  score: number

  constructor (creep: Creep, range: number) {
    this.creep = creep
    this.range = range
    this.score = this.calculateScore()
  }

  private calculateScore () : number {
    return 0
  }
}

function towerSomethingPower(startAmount: number, startRange: number) : number {
  let amount = startAmount
  let range = startRange

  if(range > TOWER_OPTIMAL_RANGE) {
      if(range > TOWER_FALLOFF_RANGE) range = TOWER_FALLOFF_RANGE
      amount -= amount * TOWER_FALLOFF * (range - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE)
      amount = Math.floor(amount)
  }

  return amount
}

function towerAttackPower(target: StructureTowerScore) : number {
  return towerSomethingPower(TOWER_POWER_ATTACK, target.range)
}

function towerHealPower(target: StructureTowerScore) : number {
  return towerSomethingPower(TOWER_POWER_HEAL, target.range)
}

function operateTower (tower: StructureTower): void {
  if (tower.cooldown > 0) return
  if (tower.store.getUsedCapacity(RESOURCE_ENERGY) < TOWER_ENERGY_COST) return

  const wasteful = tower.store.getFreeCapacity(RESOURCE_ENERGY) < TOWER_ENERGY_COST

  let allCreepsInRange = allCreeps()
  .filter(operational)
  .filter(
    function (creep: Creep) : boolean {
      if (creep.my) return notMaxHits(creep)
      return true
    }
  )
  .map(
    function (creep: Creep) : StructureTowerScore {
      let range = getRange(this, creep)
      return new StructureTowerScore(creep, range)
    }
    , tower
  )
  .filter(
    function (target: StructureTowerScore) : boolean {
      return target.range <= TOWER_RANGE
    }
  )

  if (allCreepsInRange.length === 0) return

  const target = allCreepsInRange[0].creep
  if (target.my) {
    tower.heal(target)
  } else {
    tower.attack(target)
  }
}

function atSamePosition (a: Position, b: Position) : boolean {
  return a.x === b.x && a.y === b.y
}

function getDirectionByPosition (from: Position, to: Position) : Direction | undefined {
  if (atSamePosition(from, to)) return undefined

  const dx = from.x - to.x
  const dy = from.y - to.y

  return getDirection(dx, dy)
}

function toFlagNoPathfinding (creep: Creep, flag: Flag) : void {
  const direction = getDirectionByPosition(creep, flag)
  if (direction !== undefined) {
    creep.move(direction)
  }
}

function toFlagYesPathfinding (creep: Creep, flag: Flag) : void {
  creep.moveTo(flag)
}

function advanceFlagGoal (flagGoal: FlagGoal) {
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

class AttackableAndRange {
  attackable: Attackable
  range: number

  constructor (attackable: Attackable, range: number) {
    this.attackable = attackable
    this.range = range
  }
}

function autoMelee (creep: Creep, attackables: Attackable[]) {
  if (!hasActiveBodyPart(creep, ATTACK)) return

  const inRange = creep.findInRange(attackables, 1)
  if (inRange.length > 0) {
    const target = inRange[0]
    creep.attack(target)
    new Visual().line(creep, target)
  }
}

function rangedMassAttackPower (target: AttackableAndRange) : number {
  return RANGED_ATTACK_POWER * (RANGED_ATTACK_DISTANCE_RATE[target.range] || 0)
}

function autoRanged (creep: Creep, attackables: Attackable[]) {
  if (!hasActiveBodyPart(creep, RANGED_ATTACK)) return

  const inRange = attackables.map(
    function (target: Attackable) : AttackableAndRange {
      const range = getRange(this, target)
      return new AttackableAndRange(target, range)
    }, creep
  ).filter(
    function (target: AttackableAndRange) : boolean {
      return target.range <= 3
    }
  )

  if (inRange.length === 0) return

  const totalMassAttackPower = inRange.map(rangedMassAttackPower).reduce((sum, current) => sum + current, 0)

  if (totalMassAttackPower >= RANGED_ATTACK_POWER) {
    creep.rangedMassAttack()
  } else {
    const target = inRange[0].attackable
    creep.rangedAttack(target)
    new Visual().line(creep, target)
  }
}

function autoHeal (creep: Creep, healables: Creep[]) {
  if (!hasActiveBodyPart(creep, HEAL)) return

  if (notMaxHits(creep)) {
    creep.heal(creep)
    return
  }

  const inRange = healables.map(
    function (target: Creep) : AttackableAndRange {
      const range = getRange(this, target)
      return new AttackableAndRange(target, range)
    }, creep
  ).filter(
    function (target: AttackableAndRange) : boolean {
      return target.range <= 3
    }
  )

  if (inRange.length === 0) return

  const inTouch = inRange.find(
    function (target: AttackableAndRange) : boolean {
      return target.range <= 1
    }
  )

  if (inTouch !== undefined) {
    creep.heal(inTouch.attackable as Creep)
  } else {
    const target = inRange[0].attackable as Creep
    creep.rangedHeal(target)
    new Visual().line(creep, target)
  }
}

function autoAll (creep: Creep, attackables: Attackable[], healables: Creep[]) {
  autoMelee(creep, attackables)
  autoRanged(creep, attackables)
  autoHeal(creep, healables)
}

function play (): void {
  flagGoals.forEach(advanceFlagGoal)

  const ticks = getTicks()

  // to not waste time before any meaningful work for towers is possible
  if (ticks > (engageDistance / 2 - 5)) {
    myPlayerInfo.towers.filter(operational).forEach(operateTower)
  }

  // to not waste time before any meaningful work for creeps is possible
  if (ticks > (engageDistance / 3 - 5)) {
    const enemyCreeps = enemyPlayerInfo.creeps.filter(operational)
    const enemyTowers = enemyPlayerInfo.towers.filter(operational)
    const enemyAttackables = (enemyCreeps as Attackable[]).concat(enemyTowers as Attackable[])

    const myCreeps = myPlayerInfo.creeps.filter(operational)
    const myHealableCreeps = myCreeps.filter(notMaxHits)

    const context = {
      enemyAttackables,
      myHealableCreeps
    }

    myCreeps.forEach(
      function (creep) : void {
        autoAll(creep, this.enemyAttackables, this.myHealableCreeps)
      }, context
    )
  }
}
