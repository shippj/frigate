import { CombinedStorageGraph } from "@/components/graph/CombinedStorageGraph";
import { StorageGraph } from "@/components/graph/StorageGraph";
import { FrigateStats } from "@/types/stats";
import { useEffect, useMemo, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import useSWR from "swr";
import { CiCircleAlert } from "react-icons/ci";
import { FrigateConfig } from "@/types/frigateConfig";
import {
  useFormattedTimestamp,
  useTimeFormat,
  useTimezone,
} from "@/hooks/use-date-utils";
import { RecordingsSummary } from "@/types/review";
import { useTranslation } from "react-i18next";
import { TZDate } from "react-day-picker";
import { Link } from "react-router-dom";
import { useDocDomain } from "@/hooks/use-doc-domain";
import { LuExternalLink } from "react-icons/lu";
import { FaExclamationTriangle } from "react-icons/fa";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getUnitSize } from "@/utils/storageUtil";
import { baseUrl } from "@/api/baseUrl";
import axios from "axios";

type OrphanedCameraStorage = {
  [key: string]: {
    usage: number;
    recording_count: number;
    start_time: number;
    end_time: number;
    previews: {
      path: string;
      start_time: number;
      end_time: number;
    }[];
  };
};

type CameraStorage = {
  [key: string]: {
    bandwidth: number;
    usage: number;
    usage_percent: number;
  };
};

type StorageMetricsProps = {
  setLastUpdated: (last: number) => void;
};
export default function StorageMetrics({
  setLastUpdated,
}: StorageMetricsProps) {
  const { data: cameraStorage, mutate: refreshCameraStorage } =
    useSWR<CameraStorage>("recordings/storage");
  const { data: orphanedCameraStorage, mutate: refreshOrphanedStorage } =
    useSWR<OrphanedCameraStorage>("recordings/storage/orphans");
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [mergingCamera, setMergingCamera] = useState<string>();
  const { data: stats } = useSWR<FrigateStats>("stats");
  const { data: config } = useSWR<FrigateConfig>("config", {
    revalidateOnFocus: false,
  });
  const { t } = useTranslation(["views/system"]);
  const timezone = useTimezone(config);
  const { getLocaleDocUrl } = useDocDomain();

  const totalStorage = useMemo(() => {
    if (!cameraStorage || !stats) {
      return undefined;
    }

    const totalStorage = {
      used: stats.service.storage["/media/frigate/recordings"]["used"],
      camera: 0,
      total: stats.service.storage["/media/frigate/recordings"]["total"],
    };

    Object.values(cameraStorage).forEach(
      (cam) => (totalStorage.camera += cam.usage),
    );
    return totalStorage;
  }, [cameraStorage, stats]);

  useEffect(() => {
    if (totalStorage) {
      setLastUpdated(Math.floor(Date.now() / 1000));
    }
  }, [totalStorage, setLastUpdated]);

  // recordings summary

  const { data: recordingsSummary } = useSWR<RecordingsSummary>([
    "recordings/summary",
    {
      timezone: timezone,
    },
  ]);

  const earliestDate = useMemo(() => {
    const keys = Object.keys(recordingsSummary || {});
    return keys.length
      ? new TZDate(keys[0] + "T00:00:00", timezone).getTime() / 1000
      : null;
  }, [recordingsSummary, timezone]);

  const timeFormat = useTimeFormat(config);
  const format = useMemo(() => {
    return t(`time.formattedTimestampMonthDayYear.${timeFormat}`, {
      ns: "common",
    });
  }, [t, timeFormat]);

  const formattedEarliestDate = useFormattedTimestamp(
    earliestDate || 0,
    format,
    timezone,
  );

  const shmFrameLifetime = useMemo(() => {
    if (!stats || !config) {
      return undefined;
    }

    const shmFrameCount = stats.service.storage["/dev/shm"]?.shm_frame_count;

    if (!shmFrameCount || shmFrameCount <= 0) {
      return undefined;
    }

    let maxCameraFps = 0;

    for (const [name, camStats] of Object.entries(stats.cameras)) {
      if (config.cameras[name]?.enabled && camStats.camera_fps > 0) {
        maxCameraFps = Math.max(maxCameraFps, camStats.camera_fps);
      }
    }

    if (maxCameraFps === 0) {
      return undefined;
    }

    return {
      frames: shmFrameCount,
      lifetime: Math.round((shmFrameCount / maxCameraFps) * 10) / 10,
    };
  }, [stats, config]);

  const configuredCameras = useMemo(
    () => Object.keys(config?.cameras ?? {}),
    [config],
  );

  const orphanedEntries = useMemo(
    () =>
      Object.entries(orphanedCameraStorage ?? {}).sort(
        (a, b) => b[1].usage - a[1].usage,
      ),
    [orphanedCameraStorage],
  );

  const mergeOrphanedCamera = async (camera: string) => {
    const targetCamera = mergeTargets[camera] ?? configuredCameras[0];

    if (!targetCamera) {
      return;
    }

    setMergingCamera(camera);
    try {
      await axios.post(
        `recordings/storage/orphans/${encodeURIComponent(camera)}/merge`,
        {
          target_camera: targetCamera,
        },
      );
      await Promise.all([refreshOrphanedStorage(), refreshCameraStorage()]);
    } finally {
      setMergingCamera(undefined);
    }
  };

  if (
    !cameraStorage ||
    !stats ||
    !totalStorage ||
    !config ||
    !orphanedCameraStorage
  ) {
    return (
      <div className="flex size-full items-center justify-center">
        <ActivityIndicator />
      </div>
    );
  }

  return (
    <div className="scrollbar-container mt-4 flex size-full flex-col overflow-y-auto">
      <div className="text-sm font-medium text-muted-foreground">
        {t("storage.overview")}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="flex-col rounded-lg bg-background_alt p-2.5 md:rounded-2xl">
          <div className="mb-5 flex flex-row items-center justify-between">
            {t("storage.recordings.title")}
            <Popover>
              <PopoverTrigger asChild>
                <button
                  className="focus:outline-none"
                  aria-label={t(
                    "storage.cameraStorage.unusedStorageInformation",
                  )}
                >
                  <CiCircleAlert
                    className="size-5"
                    aria-label={t(
                      "storage.cameraStorage.unusedStorageInformation",
                    )}
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-80">
                <div className="space-y-2">{t("storage.recordings.tips")}</div>
              </PopoverContent>
            </Popover>
          </div>
          <StorageGraph
            graphId="general-recordings"
            used={totalStorage.camera}
            total={totalStorage.total}
          />
          {earliestDate && (
            <div className="mt-2 text-xs text-primary-variant">
              <span className="font-medium">
                {t("storage.recordings.earliestRecording")}
              </span>{" "}
              {formattedEarliestDate}
            </div>
          )}
        </div>
        <div className="flex-col rounded-lg bg-background_alt p-2.5 md:rounded-2xl">
          <div className="mb-5">/tmp/cache</div>
          <StorageGraph
            graphId="general-cache"
            used={stats.service.storage["/tmp/cache"]["used"]}
            total={stats.service.storage["/tmp/cache"]["total"]}
          />
        </div>
        <div className="flex-col rounded-lg bg-background_alt p-2.5 md:rounded-2xl">
          <div className="mb-5 flex flex-row items-center justify-between">
            /dev/shm
            <div className="flex flex-row items-center gap-2">
              {shmFrameLifetime && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      className="focus:outline-none"
                      aria-label={t("storage.shm.frameLifetime.title")}
                    >
                      <CiCircleAlert
                        className="size-5"
                        aria-label={t("storage.shm.frameLifetime.title")}
                      />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80">
                    <div className="space-y-2">
                      {t("storage.shm.frameLifetime.description", {
                        frames: shmFrameLifetime.frames,
                        lifetime: shmFrameLifetime.lifetime,
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
              {stats.service.storage["/dev/shm"]["total"] <
                (stats.service.storage["/dev/shm"]["min_shm"] ?? 0) && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      className="focus:outline-none"
                      aria-label={t("storage.shm.title")}
                    >
                      <FaExclamationTriangle
                        className="size-5 text-danger"
                        aria-label={t("storage.shm.title")}
                      />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80">
                    <div className="space-y-2">
                      {t("storage.shm.warning", {
                        total: stats.service.storage["/dev/shm"]["total"],
                        min_shm: stats.service.storage["/dev/shm"]["min_shm"],
                      })}
                      <div className="mt-2 flex items-center text-primary">
                        <Link
                          to={getLocaleDocUrl(
                            "frigate/installation#calculating-required-shm-size",
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline"
                        >
                          {t("readTheDocumentation", { ns: "common" })}
                          <LuExternalLink className="ml-2 inline-flex size-3" />
                        </Link>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </div>
          <StorageGraph
            graphId="general-shared-memory"
            used={stats.service.storage["/dev/shm"]["used"]}
            total={stats.service.storage["/dev/shm"]["total"]}
          />
        </div>
      </div>
      <div className="mt-4 text-sm font-medium text-muted-foreground">
        {t("storage.cameraStorage.title")}
      </div>
      <div className="mt-4 bg-background_alt p-2.5 md:rounded-2xl">
        <CombinedStorageGraph
          graphId={`single-storage`}
          cameraStorage={cameraStorage}
          totalStorage={totalStorage}
        />
      </div>
      {orphanedEntries.length > 0 && (
        <>
          <div className="mt-4 text-sm font-medium text-muted-foreground">
            {t("storage.orphanedCameras.title")}
          </div>
          <div className="mt-4 space-y-3">
            {orphanedEntries.map(([camera, storage]) => (
              <div
                key={camera}
                className="rounded-lg bg-background_alt p-2.5 md:rounded-2xl"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="text-sm font-medium">
                      {camera.replaceAll("_", " ")}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {t("storage.orphanedCameras.details", {
                        storage: getUnitSize(storage.usage),
                        count: storage.recording_count,
                      })}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Select
                      value={mergeTargets[camera] ?? configuredCameras[0]}
                      onValueChange={(value) =>
                        setMergeTargets((prev) => ({
                          ...prev,
                          [camera]: value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-full sm:w-[180px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {configuredCameras.map((configuredCamera) => (
                          <SelectItem
                            key={configuredCamera}
                            value={configuredCamera}
                          >
                            {configuredCamera.replaceAll("_", " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      onClick={() => mergeOrphanedCamera(camera)}
                      disabled={
                        !configuredCameras.length || mergingCamera === camera
                      }
                    >
                      {mergingCamera === camera
                        ? t("storage.orphanedCameras.merging")
                        : t("storage.orphanedCameras.merge")}
                    </Button>
                  </div>
                </div>
                {storage.previews.length > 0 && (
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {storage.previews.map((preview) => (
                      <video
                        key={preview.path}
                        className="aspect-video w-full rounded-md bg-black object-cover"
                        src={`${baseUrl}${preview.path}`}
                        controls
                        preload="metadata"
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
