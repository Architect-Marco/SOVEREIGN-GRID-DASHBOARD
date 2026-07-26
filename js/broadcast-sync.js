/* 
   SOVEREIGN DISPATCHER V20.0
   The Bridge between Dashboard & Radio Repositories
*/
const SovereignDispatcher = {
    TOKEN: 'ghp_Qsr7MyIeGliuhkDpgcu2BIvci0vPFR1T0vpa', 
    OWNER: 'architect-marco',

    async syncStation(repo, playlistData) {
        console.log(`[DISPATCH] Target: ${repo} | Status: Initiating...`);
        const path = 'data/playlist.json';
        const url = `https://api.github.com/repos/${this.OWNER}/${repo}/contents/${path}`;

        try {
            // 1. Get current file state
            const response = await fetch(url, {
                headers: { 'Authorization': `token ${this.TOKEN}` }
            });
            
            if (!response.ok) {
                console.error("Target playlist.json not found.");
                return;
            }
            
            const file = await response.json();

            // 2. Push the update
            const putRes = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `token ${this.TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: "📡 Sovereign Grid: Broadcast Sync",
                    content: btoa(JSON.stringify(playlistData, null, 2)),
                    sha: file.sha
                })
            });

            if (putRes.ok) {
                alert(`STATION SYNCED: ${repo} is updated.`);
            }
        } catch (err) {
            console.error("❌ [DISPATCH FAILED]", err);
        }
    }
};
