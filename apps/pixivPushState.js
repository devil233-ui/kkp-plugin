export function buildPerTargetQueues(latestIllusts, groupProgress, groupIds, limit = 3) {
    const sortedIllusts = [ ...latestIllusts ].sort((a, b) => Number(a.id) - Number(b.id));
    const queuedIdsByGroup = new Map();
    const selectedIds = new Set();

    for (const groupId of groupIds) {
        const storedMax = Number(groupProgress.get(groupId) || 0);
        const queuedIds = new Set(
            sortedIllusts
                .filter(illust => Number(illust.id) > storedMax)
                .slice(0, limit)
                .map(illust => String(illust.id))
        );

        queuedIdsByGroup.set(groupId, queuedIds);
        for (const illustId of queuedIds) selectedIds.add(illustId);
    }

    return {
        queuedIdsByGroup,
        targetIllusts: sortedIllusts.filter(illust => selectedIds.has(String(illust.id)))
    };
}
