import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { ChartSeed } from '../hooks/useBreakoutEngine';
import { volumeDelta } from '../strategy/breakout';
import type { Candle, Direction, Levels } from '../types';

export interface ChartMarker {
  time: number;
  direction: Direction;
  /** Found by the history scan (drawn dimmed) vs fired live this session. */
  historical: boolean;
}

interface Props {
  seed: ChartSeed;
  lastBar: Candle | null;
  levels: Levels | null;
  markers: ChartMarker[];
}

const UP = '#26a69a';
const DOWN = '#ef5350';
const UP_DIM = 'rgba(38, 166, 154, 0.5)';
const DOWN_DIM = 'rgba(239, 83, 80, 0.5)';

function candleBar(c: Candle) {
  return { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
}

function volumeBar(c: Candle) {
  return {
    time: c.time as UTCTimestamp,
    value: c.volume,
    color: c.close >= c.open ? 'rgba(38, 166, 154, 0.4)' : 'rgba(239, 83, 80, 0.4)',
  };
}

export default function ChartPanel({ seed, lastBar, levels, markers }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const resistanceLineRef = useRef<IPriceLine | null>(null);
  const supportLineRef = useRef<IPriceLine | null>(null);
  const cvdRef = useRef<ISeriesApi<'Line'> | null>(null);
  // Running CVD bookkeeping so live ticks update the line without a rescan:
  // base = cumulative delta through the bar BEFORE the latest one.
  const cvdBaseRef = useRef(0);
  const cvdLastTimeRef = useRef<number | null>(null);
  const cvdLastDeltaRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b949e',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(110, 118, 129, 0.08)' },
        horzLines: { color: 'rgba(110, 118, 129, 0.08)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: 'rgba(110, 118, 129, 0.3)',
        rightOffset: 5,
      },
      rightPriceScale: { borderColor: 'rgba(110, 118, 129, 0.3)' },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
    });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.28 } });

    // Volume histogram pinned to the bottom of the pane on its own overlay scale.
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    // CVD line shares the bottom pane with the volume histogram.
    const cvd = chart.addSeries(LineSeries, {
      color: '#b794f6',
      lineWidth: 1,
      priceScaleId: 'cvd',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: { type: 'volume' },
    });
    chart.priceScale('cvd').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    cvdRef.current = cvd;
    markersRef.current = createSeriesMarkers(candles, []);

    return () => {
      markersRef.current = null;
      resistanceLineRef.current = null;
      supportLineRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      cvdRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  // Full redraw on (re)load / timeframe switch.
  useEffect(() => {
    const candleSeries = candleRef.current;
    const volumeSeries = volumeRef.current;
    if (!candleSeries || !volumeSeries) return;
    candleSeries.setData(seed.candles.map(candleBar));
    volumeSeries.setData(seed.candles.map(volumeBar));
    let cum = 0;
    cvdRef.current?.setData(
      seed.candles.map((c) => {
        const d = volumeDelta(c);
        if (Number.isFinite(d)) cum += d;
        return { time: c.time as UTCTimestamp, value: cum };
      }),
    );
    const lastSeed = seed.candles[seed.candles.length - 1];
    cvdLastDeltaRef.current = lastSeed && Number.isFinite(volumeDelta(lastSeed)) ? volumeDelta(lastSeed) : 0;
    cvdBaseRef.current = cum - cvdLastDeltaRef.current;
    cvdLastTimeRef.current = lastSeed ? lastSeed.time : null;
    if (seed.candles.length > 0) {
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: Math.max(0, seed.candles.length - 120),
        to: seed.candles.length + 4,
      });
    }
  }, [seed]);

  // Incremental update for live ticks.
  useEffect(() => {
    if (!lastBar) return;
    candleRef.current?.update(candleBar(lastBar));
    volumeRef.current?.update(volumeBar(lastBar));
    const delta = volumeDelta(lastBar);
    if (Number.isFinite(delta) && cvdLastTimeRef.current !== null) {
      if (lastBar.time > cvdLastTimeRef.current) {
        // Previous bar is final — roll its delta into the base.
        cvdBaseRef.current += cvdLastDeltaRef.current;
        cvdLastTimeRef.current = lastBar.time;
      }
      cvdLastDeltaRef.current = delta;
      cvdRef.current?.update({ time: lastBar.time as UTCTimestamp, value: cvdBaseRef.current + delta });
    }
  }, [lastBar]);

  // Support / resistance lines.
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    if (!levels) {
      if (resistanceLineRef.current) series.removePriceLine(resistanceLineRef.current);
      if (supportLineRef.current) series.removePriceLine(supportLineRef.current);
      resistanceLineRef.current = null;
      supportLineRef.current = null;
      return;
    }
    if (resistanceLineRef.current) {
      resistanceLineRef.current.applyOptions({ price: levels.resistance });
    } else {
      resistanceLineRef.current = series.createPriceLine({
        price: levels.resistance,
        color: UP,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'R',
      });
    }
    if (supportLineRef.current) {
      supportLineRef.current.applyOptions({ price: levels.support });
    } else {
      supportLineRef.current = series.createPriceLine({
        price: levels.support,
        color: DOWN,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'S',
      });
    }
  }, [levels]);

  // Breakout arrows.
  useEffect(() => {
    const plugin = markersRef.current;
    if (!plugin) return;
    const items: SeriesMarker<Time>[] = markers.map((m) => ({
      time: m.time as UTCTimestamp,
      position: m.direction === 'up' ? 'belowBar' : 'aboveBar',
      shape: m.direction === 'up' ? 'arrowUp' : 'arrowDown',
      color: m.direction === 'up' ? (m.historical ? UP_DIM : UP) : m.historical ? DOWN_DIM : DOWN,
      size: m.historical ? 1 : 2,
    }));
    plugin.setMarkers(items);
  }, [markers]);

  return <div className="chart-host" ref={hostRef} />;
}
