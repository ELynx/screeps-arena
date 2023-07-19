import { getTicks } from '/game/utils';

function loop() {
    console.log('Current tick: ', getTicks());
}

export { loop };
