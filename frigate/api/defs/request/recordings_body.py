"""Request bodies for recording operations."""

from pydantic import BaseModel, constr


class RecordingsMergeBody(BaseModel):
    """Request body for merging orphaned recordings into a camera."""

    target_camera: constr(min_length=1)
