import {TradeOfferState} from '../types/steam_constants';
import {Trade, TradeState} from '../types/float_market';
import {TradeOfferStatus, TradeOffersType} from '../bridge/handlers/trade_offer_status';
import {clearAccessTokenFromStorage, getAccessToken} from './access_token';
import {AnnotateOffer} from '../bridge/handlers/annotate_offer';
import {PingCancelTrade} from '../bridge/handlers/ping_cancel_trade';

interface OfferStatus {
    offer_id: string;
    state: TradeOfferState;
    given_asset_ids?: string[];
    received_asset_ids?: string[];
}

export async function pingSentTradeOffers(pendingTrades: Trade[]) {
    const {offers, type} = await getSentTradeOffers();

    const offersToFind = pendingTrades.reduce((acc, e) => {
        acc[e.steam_offer.id] = true;
        return acc;
    }, {} as {[key: string]: boolean});

    // We only want to send offers that are relevant to verifying trades on CSFloat
    const offersForCSFloat = offers.filter((e) => {
        return !!offersToFind[e.offer_id];
    });

    if (offersForCSFloat.length > 0) {
        await TradeOfferStatus.handleRequest({sent_offers: offersForCSFloat, type}, {});
    }

    // Any trade offers to attempt to annotate in case they sent the trade offer outside of CSFloat
    // This is something they shouldn't do, but you can't control the will of users to defy
    for (const offer of offers) {
        if (offer.state !== TradeOfferState.Active) {
            // If it was already accepted, trade history will send the appropriate ping
            continue;
        }

        const hasTradeWithNoOfferAnnotated = pendingTrades.find((e) => {
            if (e.steam_offer.id) {
                // Already has a steam offer
                return false;
            }

            return (offer.given_asset_ids || []).includes(e.contract.item.asset_id);
        });
        if (!hasTradeWithNoOfferAnnotated) {
            // Couldn't find matching trade on CSFloat
            continue;
        }

        try {
            await AnnotateOffer.handleRequest(
                {
                    offer_id: offer.offer_id,
                    given_asset_ids: offer.given_asset_ids || [],
                    received_asset_ids: offer.received_asset_ids || [],
                },
                {}
            );
        } catch (e) {
            console.error(`failed to annotate offer ${offer.offer_id} post-hoc`, e);
        }
    }
}

export async function pingCancelTrades(pendingTrades: Trade[]) {
    const hasWaitForCancelPing = pendingTrades.find((e) => e.state === TradeState.PENDING && e.wait_for_cancel_ping);
    if (!hasWaitForCancelPing) {
        // Nothing to process/ping, exit
        return;
    }

    const tradeOffers = await getSentAndReceivedTradeOffersFromAPI();

    const allTradeOffers = [...(tradeOffers.sent || []), ...(tradeOffers.received || [])];

    for (const trade of pendingTrades) {
        if (trade.state !== TradeState.PENDING) {
            continue;
        }

        if (!trade.wait_for_cancel_ping) {
            continue;
        }

        const tradeOffer = allTradeOffers.find((e) => e.offer_id === trade.steam_offer.id);
        if (
            tradeOffer &&
            (tradeOffer.state === TradeOfferState.Active ||
                tradeOffer.state === TradeOfferState.Accepted ||
                tradeOffer.state === TradeOfferState.CreatedNeedsConfirmation)
        ) {
            // We don't want to send a cancel ping if the offer is active or valid
            continue;
        }

        try {
            await PingCancelTrade.handleRequest({trade_id: trade.id}, {});
        } catch (e) {
            console.error(`failed to send cancel ping for trade ${trade.id}`, e);
        }
    }
}
async function getEnglishSentTradeOffersHTML(): Promise<string> {
    const resp = await fetch(`https://steamcommunity.com/id/me/tradeoffers/sent`, {
        credentials: 'include',
        // Expect redirect since we're using `me` above
        redirect: 'follow',
    });

    const body = await resp.text();

    if (body.match(/<html .+? lang="en">/)) {
        // Already english, return
        return body;
    }

    // Explicitly fetch in english instead (we need to use the redirect URL)
    const englishResp = await fetch(`${resp.url}?l=english`, {
        credentials: 'include',
        // Expect redirect since we're using `me` above
        redirect: 'follow',
    });

    return englishResp.text();
}

async function getSentTradeOffers(): Promise<{offers: OfferStatus[]; type: TradeOffersType}> {
    try {
        const offers = await getSentTradeOffersFromAPI();
        if (offers.length > 0) {
            // Hedge in case this endpoint gets killed, only return if there are results, fallback to HTML parser
            return {offers, type: TradeOffersType.API};
        } else {
            throw new Error('failed to get trade offers');
        }
    } catch (e) {
        await clearAccessTokenFromStorage();
        // Fallback to HTML parsing
        const offers = await getTradeOffersFromHTML();
        return {offers, type: TradeOffersType.HTML};
    }
}

interface TradeOfferItem {
    assetid: string;
}

interface TradeOffersAPIOffer {
    tradeofferid: string;
    accountid_other: string;
    trade_offer_state: TradeOfferState;
    items_to_give?: TradeOfferItem[];
    items_to_receive?: TradeOfferItem[];
}

interface TradeOffersAPIResponse {
    response: {
        trade_offers_sent: TradeOffersAPIOffer[];
        trade_offers_received: TradeOffersAPIOffer[];
    };
}

function offerStateMapper(e: TradeOffersAPIOffer): OfferStatus {
    return {
        offer_id: e.tradeofferid,
        state: e.trade_offer_state,
        given_asset_ids: (e.items_to_give || []).map((e) => e.assetid),
        received_asset_ids: (e.items_to_receive || []).map((e) => e.assetid),
    } as OfferStatus;
}

async function getSentTradeOffersFromAPI(): Promise<OfferStatus[]> {
    const access = await getAccessToken();

    const resp = await fetch(
        `https://api.steampowered.com/IEconService/GetTradeOffers/v1/?access_token=${access.token}&get_sent_offers=true`,
        {
            credentials: 'include',
        }
    );

    if (resp.status !== 200) {
        throw new Error('invalid status');
    }

    const data = (await resp.json()) as TradeOffersAPIResponse;
    return data.response.trade_offers_sent.map(offerStateMapper);
}

async function getSentAndReceivedTradeOffersFromAPI(): Promise<{received: OfferStatus[]; sent: OfferStatus[]}> {
    const access = await getAccessToken();

    const resp = await fetch(
        `https://api.steampowered.com/IEconService/GetTradeOffers/v1/?access_token=${access.token}&get_received_offers=true&get_sent_offers=true`,
        {
            credentials: 'include',
        }
    );

    if (resp.status !== 200) {
        throw new Error('invalid status');
    }

    const data = (await resp.json()) as TradeOffersAPIResponse;
    return {
        received: data.response.trade_offers_received.map(offerStateMapper),
        sent: data.response.trade_offers_sent.map(offerStateMapper),
    };
}

const BANNER_TO_STATE: {[banner: string]: TradeOfferState} = {
    accepted: TradeOfferState.Accepted,
    counter: TradeOfferState.Countered,
    expired: TradeOfferState.Expired,
    cancel: TradeOfferState.Canceled,
    declined: TradeOfferState.Declined,
    invalid: TradeOfferState.InvalidItems,
    'mobile confirmation': TradeOfferState.CreatedNeedsConfirmation,
    escrow: TradeOfferState.InEscrow,
};

async function getTradeOffersFromHTML(): Promise<OfferStatus[]> {
    const body = await getEnglishSentTradeOffersHTML();

    return parseTradeOffersHTML(body);
}

function parseTradeOffersHTML(body: string): OfferStatus[] {
    const matches = body.matchAll(
        /<div class="tradeoffer" id="tradeofferid_(\d+?)">.+?tradeoffer_items_ctn(.+?inactive.+?tradeoffer_items_banner\s*">([^<]+))?/gms
    );
    return [...matches]
        .map((e) => {
            const offerID = e[1];

            if (!e[2]) {
                // It is active since it didn't match on inactive groups
                return {
                    offer_id: offerID,
                    state: TradeOfferState.Active,
                };
            }

            const bannerText = e[3].toLowerCase();
            const stateEntry = Object.entries(BANNER_TO_STATE).find((e) => bannerText.includes(e[0]));
            if (!stateEntry) {
                return {
                    offer_id: offerID,
                    state: TradeOfferState.Invalid,
                };
            }

            return {
                offer_id: offerID,
                state: stateEntry[1],
            };
        })
        .filter((e) => !!e.offer_id);
}
