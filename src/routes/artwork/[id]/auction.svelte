<script>
  import Fa from "svelte-fa";
  import { faChevronLeft } from "@fortawesome/free-solid-svg-icons";
  import { faQuestionCircle } from "@fortawesome/free-regular-svg-icons";
  import { Psbt } from "@asoltys/liquidjs-lib";
  import { Buffer } from "buffer";
  import { tick } from "svelte";
  import { page } from "$app/stores";
  import { getArtwork } from "$queries/artworks";
  import { mutation, subscription, operationStore } from "@urql/svelte";
  import { updateArtwork } from "$queries/artworks";
  import { api } from "$lib/api";
  import {
    fee,
    password,
    sighash,
    prompt,
    psbt,
    user,
    token,
  } from "$lib/store";
  import { requireLogin, requirePassword } from "$lib/auth";
  import { createTransaction } from "$queries/transactions";
  import {
    createSwap,
    cancelSwap,
    sign,
    signAndBroadcast,
    signOver,
    sendToMultisig,
    requestSignature,
    createRelease,
  } from "$lib/wallet";
  import {
    format,
    addDays,
    compareAsc,
    isWithinInterval,
    parse,
    parseISO,
    addMinutes,
    addSeconds,
  } from "date-fns";
  import {
    btc,
    goto,
    err,
    info,
    units,
    sats,
    val,
    tickers,
    assetLabel,
  } from "$lib/utils";
  import ProgressLinear from "$components/ProgressLinear";
  import Select from "svelte-select";

  let { id } = $page.params;
  $: requireLogin($page);

  let input;
  let initialized;
  let focus = (i) => i && tick().then(() => input && input.focus());
  $: focus(initialized);

  let loading = true;
  let artwork, list_price, royalty;
  subscription(operationStore(getArtwork(id)), (a, b) => {
    artwork = {
      ...b.artworks_by_pk,
    };

    if (!artwork.asking_asset) artwork.asking_asset = btc;
    auction_enabled =
      compareAsc(parseISO(artwork.auction_end), new Date()) === 1;

    let start, end;
    if (artwork.auction_start) {
      start = parseISO(artwork.auction_start);
      start_date = format(start, "yyyy-MM-dd");
      start_time = format(start, "HH:mm");
    }

    if (artwork.auction_end) {
      end = parseISO(artwork.auction_end);
      end_date = format(end, "yyyy-MM-dd");
      end_time = format(end, "HH:mm");
    }

    auction_underway =
      auction_enabled &&
      isWithinInterval(new Date(), {
        start,
        end,
      });

    if (!list_price && artwork.list_price)
      list_price = val(artwork.asking_asset, artwork.list_price);
    if (!royalty) royalty = artwork.royalty;

    initialized = true;
    loading = false;
  });

  const updateArtwork$ = mutation(updateArtwork);

  const spendPreviousSwap = async () => {
    if (
      !list_price ||
      royalty ||
      artwork.auction_end ||
      parseInt(artwork.list_price || 0) ===
        sats(artwork.asking_asset, list_price)
    )
      return true;

    await requirePassword();

    if (artwork.list_price_tx) {
      $psbt = await cancelSwap(artwork, 500);

      if (artwork.royalty || artwork.auction_end) {
        $psbt = await requestSignature($psbt);
      }
      try {
        await signAndBroadcast();
        await createTransaction$({
          transaction: {
            amount: artwork.list_price,
            artwork_id: artwork.id,
            asset: artwork.asking_asset,
            hash: $psbt.extractTransaction().getId(),
            psbt: $psbt.toBase64(),
            type: "cancel",
          },
        });
      } catch (e) {
        if (e.message.includes("already"))
          throw new Error(
            "Please wait a block before changing the listing price"
          );
        else throw e;
      }
    }
  };

  const setupSwaps = async () => {
    if (
      !list_price ||
      (!stale &&
        parseInt(artwork.list_price || 0) ===
          sats(artwork.asking_asset, list_price))
    )
      return true;

    let tx;
    if (stale) tx = $psbt.extractTransaction();
    await requirePassword();

    $psbt = await createSwap(
      artwork,
      sats(artwork.asking_asset, list_price),
      tx
    );

    await sign(0x83);
    artwork.list_price_tx = $psbt.toBase64();

    await createTransaction$({
      transaction: {
        amount: sats(artwork.asking_asset, list_price),
        artwork_id: artwork.id,
        asset: artwork.asking_asset,
        hash: $psbt.__CACHE.__TX.getId(),
        psbt: $psbt.toBase64(),
        type: "listing",
      },
    });

    info("List price updated!");
  };

  let createTransaction$ = mutation(createTransaction);
  let setupAuction = async () => {
    if (!auction_enabled) return true;

    let start = parse(
      `${start_date} ${start_time}`,
      "yyyy-MM-dd HH:mm",
      new Date()
    );

    let end = parse(`${end_date} ${end_time}`, "yyyy-MM-dd HH:mm", new Date());

    if (compareAsc(start, new Date()) < 1)
      throw new Error("Start date can't be in the past");

    if (compareAsc(start, end) === 1)
      throw new Error("Start date must precede end date");

    let newAuction = !artwork.auction_end;

    if (newAuction) {
      await requirePassword();

      let base64, tx;
      if (artwork.royalty) {
        tx = await signOver(artwork, tx);
        artwork.list_price_tx = $psbt.toBase64();
      } else {
        $psbt = await sendToMultisig(artwork);
        $psbt = await signAndBroadcast();
        base64 = $psbt.toBase64();
        tx = $psbt.extractTransaction();

        tx = (await signOver(artwork, tx));
        artwork.list_price_tx = $psbt.toBase64();

        artwork.auction_release_tx = (
          await createRelease(artwork, tx)
        ).toBase64();
      }

      await createTransaction$({
        transaction: {
          amount: 1,
          artwork_id: artwork.id,
          asset: artwork.asking_asset,
          hash: tx.getId(),
          psbt: $psbt.toBase64(),
          type: "auction",
        },
      });

      if (base64) $psbt = Psbt.fromBase64(base64);
    }

    artwork.auction_start = start;
    artwork.auction_end = end;
  };

  let stale;
  let setupRoyalty = async () => {
    if (artwork.royalty || !royalty) return true;
    artwork.royalty = royalty;

    if (!artwork.auction_end) {
      await requirePassword();
      $psbt = await sendToMultisig(artwork);
      await signAndBroadcast();
    }

    await createTransaction$({
      transaction: {
        amount: 1,
        artwork_id: artwork.id,
        asset: artwork.asking_asset,
        hash: $psbt.extractTransaction().getId(),
        psbt: $psbt.toBase64(),
        type: "royalty",
      },
    });

    stale = true;

    info("Royalties activated!");
  };

  let update = async (e) => {
    loading = true;

    try {
      e.preventDefault();

      await setupAuction();
      await spendPreviousSwap();
      await setupRoyalty();
      await setupSwaps();

      let {
        id: artwork_id,
        asking_asset,
        auction_start,
        auction_end,
        asset,
        description,
        filename,
        reserve_price,
        list_price_tx,
        auction_release_tx,
        title,
        bid_increment,
        max_extensions,
        extension_interval,
      } = artwork;

      if (!auction_start) auction_start = null;
      if (!auction_end) auction_end = null;

      let result = await updateArtwork$({
        artwork: {
          list_price: sats(artwork.asking_asset, list_price),
          list_price_tx,
          auction_release_tx,
          reserve_price: sats(artwork.asking_asset, reserve_price),
          auction_start,
          auction_end,
          asking_asset,
          bid_increment,
          max_extensions,
          extension_interval,
          royalty,
        },
        id,
      });

      console.log(result);
      if (result.error) {
        throw new Error(
          `Problem updating artwork record ${result.error.message}`
        );
      }

      api.url("/asset/register").post({ asset }).json().catch(console.log);

      goto(`/a/${artwork.slug}`);
    } catch (e) {
      err(e);
      console.log(e);
    }
    loading = false;
  };

  let clearPrice = () => (list_price = undefined);

  let start_date, end_date, start_time, end_time;
  let auction_enabled, auction_underway;
  $: enableAuction(auction_enabled);
  let enableAuction = () => {
    if (!start_date) {
      start_date = format(addMinutes(new Date(), 15), "yyyy-MM-dd");
      start_time = format(addMinutes(new Date(), 15), "HH:mm");
      //start_time = format(addMinutes(new Date(), 1), "HH:mm");
    }
    if (!end_date) {
      end_date = format(addMinutes(addDays(new Date(), 3), 15), "yyyy-MM-dd");
      end_time = format(addMinutes(addDays(new Date(), 3), 15), "HH:mm");
      //end_date = format(new Date(), "yyyy-MM-dd");
      //end_time = format(addSeconds(new Date(), 90), "HH:mm");
    }
  };

  $: listingCurrencies =
    artwork && artwork.transferred_at
      ? Object.keys(tickers)
      : [...Object.keys(tickers), undefined];
</script>

<style>
  .container {
    background-color: #ecf6f7;
    width: 100% !important;
    min-height: 100vh;
    margin: 0;
    max-width: 100%;
  }

  input,
  select,
  textarea {
    @apply rounded-lg mb-4 mt-2;
    &:disabled {
      @apply bg-gray-100;
    }
  }

  .tooltip {
    cursor: pointer;
  }
  .tooltip .tooltip-text {
    visibility: hidden;
    padding: 15px;
    position: absolute;
    z-index: 100;
    width: 300px;
    font-style: normal;
  }
  .tooltip:hover .tooltip-text {
    visibility: visible;
  }

  input[type="checkbox"]:checked {
    appearance: none;
    border: 5px solid #fff;
    outline: 2px solid #6ed8e0;
    background-color: #6ed8e0;
    padding: 2px;
    border-radius: 0;
  }

  input[type="radio"]:checked {
    appearance: none;
    border: 7px solid #6ed8e0;
    background-color: #fff;
    padding: 2px;
    border-radius: 100%;
  }

  @media only screen and (max-width: 768px) {
    .container {
      background: none;
    }
    .tooltip .tooltip-text {
      width: 100%;
      left: 0px;
      top: 30px;
    }
  }
</style>

<div class="container mx-auto md:p-20">
  <div class="w-full max-w-4xl mx-auto bg-white md:p-10 rounded-xl">
    {#if artwork}
      <a class="block mb-6 text-midblue" href={`/a/${artwork.slug}`}>
        <div class="flex">
          <Fa icon={faChevronLeft} class="my-auto mr-1" />
          <div>Back</div>
        </div>
      </a>
    {/if}
    <h2>List artwork</h2>

    {#if loading}
      <ProgressLinear />
    {:else}
      {#if auction_underway}
        <h4 class="mt-12">
          Listing cannot be updated while auction is underway
        </h4>
      {/if}

      <form class="w-full mb-6 mt-12" on:submit={update} autocomplete="off">
        <div class="flex flex-col mt-4">
          <p>Listing currency</p>
          <div class="flex flex-wrap">
            {#each listingCurrencies as asset}
              <label class="ml-2 mr-6 flex items-center">
                <input
                  class="form-radio h-6 w-6 mt-4 mr-2"
                  type="radio"
                  name={asset}
                  value={asset}
                  bind:group={artwork.asking_asset}
                  on:change={clearPrice}
                  disabled={auction_underway} />
                <p class="mb-2 whitespace-nowrap">
                  {asset ? assetLabel(asset) : 'Unlisted'}
                </p>
              </label>
            {/each}
          </div>
        </div>

        {#if artwork.asking_asset}
          <div class="flex w-full sm:w-3/4 mb-4">
            <div class="relative mt-1 rounded-md w-2/3 mr-6">
              <label>Price
                <span class="tooltip">
                  <i class="text-midblue text-xl tooltip">
                    <Fa icon={faQuestionCircle} pull="right" class="mt-1" />
                  </i>
                  <span class="tooltip-text bg-gray-100 shadow ml-4 rounded">
                    Setting a price is optional. If you set one, your wallet
                    will generate a partially signed atomic swap transaction. If
                    you run an auction, this price will be the "buy it now" or
                    buyout price that lets people skip the bidding process and
                    immediately purchase the artwork.
                    <br /><br />
                    Changing the price involves sending an on-chain cancellation
                    transaction to invalidate your half of the atomic swap
                    transaction and will incur a transaction fee.
                  </span>
                </span></label>
              <input
                class="form-input block w-full pl-7 pr-12"
                placeholder={val(artwork.asking_asset, 0)}
                bind:value={list_price}
                bind:this={input}
                disabled={auction_underway} />
              <div
                class="absolute inset-y-0 right-0 flex items-center mr-2 mt-4">
                {assetLabel(artwork.asking_asset)}
              </div>
            </div>
            {#if $user.id === artwork.artist_id}
              <div class="relative mt-1 rounded-md">
                <label>Royalty Rate
                  <span class="tooltip">
                    <i class="ml-3 text-midblue text-xl tooltip">
                      <Fa icon={faQuestionCircle} pull="right" class="mt-1" />
                    </i>
                    <span class="tooltip-text bg-gray-100 shadow ml-4 rounded">
                      Setting a royalty involves transferring the artwork to a
                      2-of-2 multisig address with Raretoshi. Our server will
                      co-sign on transfers if they pay the specified royalty to
                      the original artist.
                    </span>
                  </span></label>
                <input
                  class="form-input block w-full pl-7 pr-12"
                  placeholder="0"
                  bind:value={royalty}
                  disabled={auction_underway} />
                <div
                  class="absolute inset-y-0 right-0 flex items-center mr-2 mt-4">
                  %
                </div>
              </div>
            {/if}
          </div>
          <div class="auction-toggle">
            <label class="inline-flex items-center">
              <input
                class="form-checkbox h-6 w-6 mt-3"
                type="checkbox"
                bind:checked={auction_enabled}
                disabled={auction_underway} />
              <span class="ml-3 text-xl">Create an auction</span>
            </label>
          </div>
          {#if auction_enabled}
            <div class="aution-container">
              <div class="flex auction justify-between flex-wrap">
                <div class="flex flex-col">
                  <h4 class="mb-4">Auction start</h4>
                  <div class="flex justify-between">
                    <div class="flex flex-col mb-4 mr-6">
                      <label for="date">Date</label>
                      <input
                        type="date"
                        name="date"
                        bind:value={start_date}
                        disabled={auction_underway} />
                    </div>
                    <div class="flex flex-col mb-4">
                      <label for="time">Time</label>
                      <input
                        type="time"
                        name="time"
                        bind:value={start_time}
                        disabled={auction_underway} />
                    </div>
                  </div>
                </div>
                <div class="flex flex-col">
                  <h4 class="mb-4">Auction end</h4>
                  <div class="flex justify-between">
                    <div class="flex flex-col mb-4 mr-6">
                      <label for="date">Date</label>
                      <input
                        type="date"
                        name="date"
                        bind:value={end_date}
                        disabled={auction_underway} />
                    </div>
                    <div class="flex flex-col mb-4">
                      <label for="time">Time</label>
                      <input
                        type="time"
                        name="time"
                        bind:value={end_time}
                        disabled={auction_underway} />
                    </div>
                  </div>
                </div>
              </div>
              <div class="flex flex-col mb-4">
                <div>
                  <div
                    class="mt-1 relative w-1/2 xl:w-1/3 rounded-md shadow-sm">
                    <label>
                      Reserve price
                      <span class="tooltip">
                        <i class="ml-3 text-midblue text-xl tooltip">
                          <Fa
                            icon={faQuestionCircle}
                            pull="right"
                            class="mt-1" />
                        </i>
                        <span
                          class="tooltip-text bg-gray-100 shadow ml-4 rounded">
                          Reserve price is the minimum price that you'll accept
                          for the artwork. Setting one is optional.
                        </span>
                      </span>
                      <input
                        class="form-input block w-full pl-7 pr-12"
                        placeholder="0"
                        bind:value={artwork.reserve_price}
                        disabled={auction_underway} />
                      <div
                        class="absolute inset-y-0 right-0 flex items-center mr-2 mt-8">
                        {assetLabel(artwork.asking_asset)}
                      </div>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          {/if}
        {/if}
        <div class="flex mt-10">
          <button type="submit" class="primary-btn">Submit</button>
        </div>
      </form>
    {/if}
  </div>
</div>
