import test from "node:test";
import assert from "node:assert/strict";

import { buildPerTargetQueues } from "../apps/pixivPushState.js";

test("为各目标独立选择最早三条待推送作品", () => {
    const latestIllusts = [ 105, 104, 103, 102, 101 ].map(id => ({ id }));
    const progress = new Map([
        [ "slow", 100 ],
        [ "ahead", 103 ]
    ]);

    const { queuedIdsByGroup, targetIllusts } = buildPerTargetQueues(
        latestIllusts,
        progress,
        [ "slow", "ahead" ]
    );

    assert.deepEqual([ ...queuedIdsByGroup.get("slow") ], [ "101", "102", "103" ]);
    assert.deepEqual([ ...queuedIdsByGroup.get("ahead") ], [ "104", "105" ]);
    assert.deepEqual(targetIllusts.map(illust => illust.id), [ 101, 102, 103, 104, 105 ]);
    assert.deepEqual(latestIllusts.map(illust => illust.id), [ 105, 104, 103, 102, 101 ]);
});

test("没有新作品的目标得到空队列", () => {
    const { queuedIdsByGroup, targetIllusts } = buildPerTargetQueues(
        [ { id: 2 }, { id: 1 } ],
        new Map([ [ "current", 2 ] ]),
        [ "current" ]
    );

    assert.deepEqual([ ...queuedIdsByGroup.get("current") ], []);
    assert.deepEqual(targetIllusts, []);
});
