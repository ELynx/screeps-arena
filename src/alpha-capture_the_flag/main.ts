import { Creep, GameObject, Position, Structure, StructureTower } from 'game/prototypes'
import { ATTACK, HEAL, MOVE, RANGED_ATTACK, RANGED_ATTACK_DISTANCE_RATE, RANGED_ATTACK_POWER, RESOURCE_ENERGY, TOWER_ENERGY_COST, TOWER_FALLOFF, TOWER_FALLOFF_RANGE, TOWER_OPTIMAL_RANGE, TOWER_RANGE } from 'game/constants'
import { Direction, getDirection, getObjectsByPrototype, getRange, getTicks } from 'game/utils'
import { Visual } from 'game/visual'
import { Flag } from 'arena/season_alpha/capture_the_flag/basic'

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
let flagGoals: FlagGoal[] = []
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
      if (myPlayerInfo.flag && myPlayerInfo.flag.y === creep.y) {
        flagGoals.push(new FlagGoal(creep, myPlayerInfo.flag, false))
        continue
      }

      if (enemyPlayerInfo.flag) {
        flagGoals.push(new FlagGoal(creep, enemyPlayerInfo.flag, true))
      }
    }

    if (myPlayerInfo.flag && enemyPlayerInfo.flag) {
      engageDistance = getRange(myPlayerInfo.flag as Position, enemyPlayerInfo.flag as Position)
    } else {
      engageDistance = TOWER_RANGE * 2
    }
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
  if (something!.hits && something!.hits <= 0) return false
  return true
}

function hasActiveBodyPart (creep: Creep, type: string) : boolean {
  return creep.body.some(
    function (bodyPart) : boolean {
      return bodyPart.hits > 0 && bodyPart.type === type
    }
  )
}

function notMaxHits (creep: Creep) : boolean {
  return creep.hits < creep.hitsMax
}

function towerSomethingPower (startAmount: number, startRange: number) : number {
  let amount = startAmount
  let range = startRange

  if (range > TOWER_OPTIMAL_RANGE) {
    if (range > TOWER_FALLOFF_RANGE) range = TOWER_FALLOFF_RANGE
    amount -= amount * TOWER_FALLOFF * (range - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE)
    amount = Math.floor(amount)
  }

  return amount
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
    // speed up process
    if (this.range > TOWER_RANGE) return 0

    if (this.creep.my) {
      const hitsLost = this.creep.hitsMax - this.creep.hits
      const percent = hitsLost / this.creep.hitsMax * 100
      const withFalloff = towerSomethingPower(percent, this.range)

      return Math.round(withFalloff)
    }

    let bodyCost = 0
    for (const bodyPart of this.creep.body) {
      if (bodyPart.hits <= 0) continue

      // default pair of X + MOVE is 10 in sum
      // ignore mutants for simplicity
      if (bodyPart.type === ATTACK || bodyPart.type === HEAL) bodyCost += 6
      else bodyCost += 4
    }

    // again ignore mutants for simplicity
    const maxBodyCost = this.creep.body.length * 5
    const percent = bodyCost / maxBodyCost * 100
    const withFalloff = towerSomethingPower(percent, this.range)

    return Math.round(withFalloff)
  }
}

function operateTower (tower: StructureTower): void {
  if (tower.cooldown > 0) return
  if ((tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0) < TOWER_ENERGY_COST) return

  const saveEnergy = (tower.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > TOWER_ENERGY_COST

  const allCreepsInRange = allCreeps()
    .filter(operational)
    .filter(
      function (creep: Creep) : boolean {
        if (creep.my) return notMaxHits(creep)
        return true
      }
    )
    .map(
      function (creep: Creep) : StructureTowerScore {
        const range = getRange(tower as Position, creep as Position)
        return new StructureTowerScore(creep, range)
      }
    )
    .filter(
      function (target: StructureTowerScore) : boolean {
        if (target.creep.my) {
          return target.range <= TOWER_OPTIMAL_RANGE * 3
        } else {
          return target.range <= TOWER_OPTIMAL_RANGE * 2
        }
      }
    )
    .sort(
      function (a: StructureTowerScore, b: StructureTowerScore) : number {
        return b.score - a.score
      }
    )

  if (allCreepsInRange.length === 0) return

  const target = allCreepsInRange[0]
  if (saveEnergy && target.score < 10) return

  if (target.creep.my) {
    tower.heal(target.creep)
  } else {
    tower.attack(target.creep)
  }
}

function atSamePosition (a: Position, b: Position) : boolean {
  return a.x === b.x && a.y === b.y
}

function getDirectionByPosition (from: Position, to: Position) : Direction | undefined {
  if (atSamePosition(from, to)) return undefined

  const dx = to.x - from.x
  const dy = to.y - from.y

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
    new Visual().line(creep as Position, target as Position)
  }
}

function rangedMassAttackPower (target: AttackableAndRange) : number {
  return RANGED_ATTACK_POWER * (RANGED_ATTACK_DISTANCE_RATE[target.range] || 0)
}

function autoRanged (creep: Creep, attackables: Attackable[]) {
  if (!hasActiveBodyPart(creep, RANGED_ATTACK)) return

  const inRange = attackables.map(
    function (target: Attackable) : AttackableAndRange {
      const range = getRange(creep as Position, target as Position)
      return new AttackableAndRange(target, range)
    }
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
    new Visual().line(creep as Position, target as Position)
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
      const range = getRange(creep as Position, target as Position)
      return new AttackableAndRange(target, range)
    }
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
    new Visual().line(creep as Position, target as Position)
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

    myCreeps.forEach(
      function (creep) : void {
        autoAll(creep, enemyAttackables, myHealableCreeps)
      }
    )
  }
}
