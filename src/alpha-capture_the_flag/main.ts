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

function fillPlayerInfo (whoFunction: (x: Ownable) => boolean) : PlayerInfo {
  const playerInfo = new PlayerInfo()

  playerInfo.flag = allFlags().find(whoFunction)
  playerInfo.towers = allTowers().filter(whoFunction)
  playerInfo.creeps = allCreeps().filter(whoFunction)

  return playerInfo
}

class PositionGoal {
  creep: Creep
  position: Position

  constructor (creep: Creep, position: Position) {
    this.creep = creep
    this.position = position
  }
}

let myPlayerInfo: PlayerInfo
let enemyPlayerInfo: PlayerInfo

let positionGoals: PositionGoal[] = []

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
        positionGoals.push(new PositionGoal(creep, myPlayerInfo.flag as Position))
        continue
      }

      if (enemyPlayerInfo.flag) {
        positionGoals.push(new PositionGoal(creep, enemyPlayerInfo.flag as Position))
      }
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

function towerPower (fullAmount: number, range: number) : number {
  if (range <= TOWER_OPTIMAL_RANGE) return fullAmount

  const effectiveRange = Math.min(range, TOWER_FALLOFF_RANGE)
  const effectiveAmount = fullAmount * (1 - TOWER_FALLOFF * (effectiveRange - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE))

  return Math.floor(effectiveAmount)
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
      const withFalloff = towerPower(percent, this.range)

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
    const withFalloff = towerPower(percent, this.range)

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

function advancePositionGoal (positionGoal: PositionGoal) {
  if (!operational(positionGoal.creep)) return
  if (positionGoal.creep.fatigue > 0) return
  if (!hasActiveBodyPart(positionGoal.creep, MOVE)) return

  positionGoal.creep.moveTo(positionGoal.position)
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

class PositionStatistics {
  numberOfCreeps: number

  min: number
  max: number
  average: number
  median: number

  canReach: number

  constructor (ranges: number[]) {
    this.numberOfCreeps = ranges.length
    this.min = Number.MAX_SAFE_INTEGER
    this.max = Number.MIN_SAFE_INTEGER
    this.average = NaN
    this.median = NaN
    this.canReach = 0

    if (this.numberOfCreeps === 0) return

    const ticksLimit = 2000 // TODO arena info
    const ticksNow = getTicks()
    const ticksRemaining = ticksLimit - ticksNow

    const sorted = ranges.sort()

    let total = 0
    for (let x of sorted) {
      if (x < this.min) this.min = x
      if (x > this.max) this.max = x

      this.canReach += x <= ticksRemaining ? 1 : 0

      total += x
    }

    this.average = total / this.numberOfCreeps
    this.median = sorted[Math.floor(this.numberOfCreeps) / 2]
  }
}

function calculatePositionStatistics (creeps: Creep[], position: Position) : PositionStatistics {
  const ranges = creeps.filter(operational).map(
    function (creep: Creep) : number {
      return getRange(position, creep as Position)
    }
  )

  return new PositionStatistics(ranges)
}

function calculatePositionStatisticsForFlag (creeps: Creep[], flag?: Flag) : PositionStatistics {
  if (!exists(flag)) return new PositionStatistics([])

  return calculatePositionStatistics(creeps, flag! as Position)
}

function play (): void {
  positionGoals.forEach(advancePositionGoal)

  const myAdvance = calculatePositionStatisticsForFlag(myPlayerInfo.creeps, enemyPlayerInfo.flag)
  const enemyAdvance = calculatePositionStatisticsForFlag(enemyPlayerInfo.creeps, myPlayerInfo.flag)

  myPlayerInfo.towers.filter(operational).forEach(operateTower)

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
