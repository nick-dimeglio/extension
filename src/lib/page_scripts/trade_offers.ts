import {init} from './utils';
import '../components/trade_offers/better_tracking';
import {inPageContext} from '../utils/snips';

init('src/lib/page_scripts/trade_offers.js', main);

function main() {}

if (!inPageContext()) {
    const refresh = setInterval(() => {
        const widget = document.getElementsByTagName('csfloat-better-tracking-widget');
        if (!widget || widget.length === 0) {
            return;
        }

        const btn = widget[0]?.shadowRoot?.getElementById('csfloat-enable-enhanced');
        if (!btn) {
            return;
        }

        btn.addEventListener('click', async () => {
            chrome.runtime.sendMessage(
                {
                    message: 'requestPermissions',
                    permissions: [],
                    origins: ['*://*.steampowered.com/*', '*://*.csfloat.com/*'],
                },
                (granted) => {
                    if (granted) {
                        widget[0].parentElement?.removeChild(widget[0]);
                    } else {
                        alert('Failed to obtain permissions');
                    }
                }
            );
        });

        clearInterval(refresh);
    }, 500);
}
