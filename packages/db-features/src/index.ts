import type pg from 'pg';
import type { FeatureClient, FeatureConnection, FeatureMetadata, FeatureTrack } from '@rtcstats-dashboard/rules';

export interface FeatureBundle {
  metadata: FeatureMetadata;
  client: FeatureClient | null;
  connections: FeatureConnection[];
}

export async function loadFeatures(pool: pg.Pool, dumpId: number): Promise<FeatureBundle | null> {
  const metadataResult = await pool.query(
    `select id, dump_id, start_time, useragent, number_peerconnections
     from features_metadata where dump_id = $1`,
    [dumpId]
  );
  if (metadataResult.rows.length === 0) return null;
  const metadataRow = metadataResult.rows[0];
  const metadataId = metadataRow.id;

  const metadata: FeatureMetadata = {
    id: metadataRow.id,
    dumpId: metadataRow.dump_id,
    startTime: metadataRow.start_time,
    useragent: metadataRow.useragent,
    numberPeerconnections: metadataRow.number_peerconnections
  };

  const clientResult = await pool.query(
    `select id, dump_id, hardware_concurrency, device_memory,
            called_get_user_media, get_user_media_success_count, get_user_media_error_count, get_user_media_error,
            reload_count, cpu_performance, operating_system,
            audio_ended, audio_short_duration, video_ended, video_short_duration
     from features_client where dump_id = $1`,
    [metadataId]
  );
  const client: FeatureClient | null = clientResult.rows[0]
    ? {
        id: clientResult.rows[0].id,
        dumpId: clientResult.rows[0].dump_id,
        hardwareConcurrency: clientResult.rows[0].hardware_concurrency,
        deviceMemory: clientResult.rows[0].device_memory,
        calledGetUserMedia: clientResult.rows[0].called_get_user_media,
        getUserMediaSuccessCount: clientResult.rows[0].get_user_media_success_count,
        getUserMediaErrorCount: clientResult.rows[0].get_user_media_error_count,
        getUserMediaError: clientResult.rows[0].get_user_media_error,
        reloadCount: clientResult.rows[0].reload_count,
        cpuPerformance: clientResult.rows[0].cpu_performance,
        operatingSystem: clientResult.rows[0].operating_system,
        audioEnded: clientResult.rows[0].audio_ended,
        audioShortDuration: clientResult.rows[0].audio_short_duration,
        videoEnded: clientResult.rows[0].video_ended,
        videoShortDuration: clientResult.rows[0].video_short_duration
      }
    : null;

  const connectionRows = await pool.query(
    `select id, dump_id, connection_identifier, closed,
            ice_connected, ice_connection_time, ice_restart,
            add_ice_candidate_failure, set_local_description_failure, set_remote_description_failure,
            connected, dtls_version, dtls_role, added_null_candidate,
            first_candidate_pair_local_type, first_candidate_pair_remote_type,
            average_stun_round_trip_time, ice_restart_followed_by_set_remote_description,
            signaling_delay, set_remote_description_delay, set_local_description_delay,
            set_local_description_role, set_remote_description_role,
            clock_skew, gathering_time_turn_udp, gathering_time_turn_tcp, gathering_time_turn_tls
     from features_connection where dump_id = $1`,
    [metadataId]
  );

  const connectionIds = connectionRows.rows.map((r) => r.id);
  const trackRows = connectionIds.length
    ? await pool.query(
        `select id, connection_id, track_identifier, kind, direction,
                frame_count, quality_limitation_resolution_changes,
                bandwidth_quality_limitation_percentage, cpu_quality_limitation_percentage, other_quality_limitation_percentage,
                average_encode_time, average_decode_time, freeze_count, total_freezes_duration,
                qp_sum, encoder_implementation, power_efficient_encoder, decoder_implementation, power_efficient_decoder,
                has_null_video_decoder, concealed_samples, total_samples_received, concealment_percentage,
                jitter_buffer_flushes, has_periodic_jitter_buffer_flushes,
                inserted_samples_for_deceleration, removed_samples_for_acceleration,
                deceleration_percentage, acceleration_percentage, time_to_first_frame
         from features_track where connection_id = any($1::bigint[])`,
        [connectionIds]
      )
    : { rows: [] };

  const tracksByConnection = new Map<number, FeatureTrack[]>();
  for (const t of trackRows.rows) {
    const track: FeatureTrack = {
      id: t.id,
      connectionId: t.connection_id,
      trackIdentifier: t.track_identifier,
      kind: t.kind,
      direction: t.direction,
      frameCount: t.frame_count,
      qualityLimitationResolutionChanges: t.quality_limitation_resolution_changes,
      bandwidthQualityLimitationPercentage: t.bandwidth_quality_limitation_percentage,
      cpuQualityLimitationPercentage: t.cpu_quality_limitation_percentage,
      otherQualityLimitationPercentage: t.other_quality_limitation_percentage,
      averageEncodeTime: t.average_encode_time,
      averageDecodeTime: t.average_decode_time,
      freezeCount: t.freeze_count,
      totalFreezesDuration: t.total_freezes_duration,
      qpSum: t.qp_sum,
      encoderImplementation: t.encoder_implementation,
      powerEfficientEncoder: t.power_efficient_encoder,
      decoderImplementation: t.decoder_implementation,
      powerEfficientDecoder: t.power_efficient_decoder,
      hasNullVideoDecoder: t.has_null_video_decoder,
      concealedSamples: t.concealed_samples,
      totalSamplesReceived: t.total_samples_received,
      concealmentPercentage: t.concealment_percentage,
      jitterBufferFlushes: t.jitter_buffer_flushes,
      hasPeriodicJitterBufferFlushes: t.has_periodic_jitter_buffer_flushes,
      insertedSamplesForDeceleration: t.inserted_samples_for_deceleration,
      removedSamplesForAcceleration: t.removed_samples_for_acceleration,
      decelerationPercentage: t.deceleration_percentage,
      accelerationPercentage: t.acceleration_percentage,
      timeToFirstFrame: t.time_to_first_frame
    };
    const list = tracksByConnection.get(t.connection_id) ?? [];
    list.push(track);
    tracksByConnection.set(t.connection_id, list);
  }

  const connections: FeatureConnection[] = connectionRows.rows.map((c) => ({
    id: c.id,
    dumpId: c.dump_id,
    connectionIdentifier: c.connection_identifier,
    closed: c.closed,
    iceConnected: c.ice_connected,
    iceConnectionTime: c.ice_connection_time,
    iceRestart: c.ice_restart,
    addIceCandidateFailure: c.add_ice_candidate_failure,
    setLocalDescriptionFailure: c.set_local_description_failure,
    setRemoteDescriptionFailure: c.set_remote_description_failure,
    connected: c.connected,
    dtlsVersion: c.dtls_version,
    dtlsRole: c.dtls_role,
    addedNullCandidate: c.added_null_candidate,
    firstCandidatePairLocalType: c.first_candidate_pair_local_type,
    firstCandidatePairRemoteType: c.first_candidate_pair_remote_type,
    averageStunRoundTripTime: c.average_stun_round_trip_time,
    iceRestartFollowedBySetRemoteDescription: c.ice_restart_followed_by_set_remote_description,
    signalingDelay: c.signaling_delay,
    setRemoteDescriptionDelay: c.set_remote_description_delay,
    setLocalDescriptionRole: c.set_local_description_role,
    setRemoteDescriptionRole: c.set_remote_description_role,
    setLocalDescriptionDelay: c.set_local_description_delay,
    clockSkew: c.clock_skew,
    gatheringTimeTurnUdp: c.gathering_time_turn_udp,
    gatheringTimeTurnTcp: c.gathering_time_turn_tcp,
    gatheringTimeTurnTls: c.gathering_time_turn_tls,
    tracks: tracksByConnection.get(c.id) ?? []
  }));

  return { metadata, client, connections };
}
