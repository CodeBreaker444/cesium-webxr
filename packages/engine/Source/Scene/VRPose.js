import BoundingRectangle from "../Core/BoundingRectangle.js";
import Camera from "./Camera.js";
import Cartesian3 from "../Core/Cartesian3.js";
import defaultValue from "../Core/defaultValue.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Matrix4 from "../Core/Matrix4.js";
import PerspectiveFrustum from "../Core/PerspectiveFrustum.js";
import PerspectiveOffCenterFrustum from "../Core/PerspectiveOffCenterFrustum.js";
import Scene from "./Scene.js";

const DEFAULT_IPD = 0.061; // Standard human IPD in meters
// get ipd from the webxr session

const DEFAULT_FOCAL_LENGTH_MULTIPLIER = 10.0;

function prepareViewportLegacy(pose, eye) {
  const viewport = pose.viewports[eye];
  const width = pose._passStateViewport.width * 0.5;

  // Swap left and right viewport positions
  viewport.x = eye === "left" ? width : 0; // Changed from "right" to "left"
  viewport.y = 0;
  viewport.width = width;
  viewport.height = pose._passStateViewport.height;

  console.log(`Viewport for ${eye} eye:`, {
    x: viewport.x,
    y: viewport.y,
    width: viewport.width,
    height: viewport.height,
  });
}

function prepareViewportsLegacy(pose) {
  if (!pose._paramsChanged) {
    return;
  }

  prepareViewportLegacy(pose, "left");
  prepareViewportLegacy(pose, "right");
}

function preparePoseCameraParamsLegacy(pose, camera) {
  const cameraParams = pose.cameraParams;
  const near = camera.frustum.near;

  // Use more realistic values for VR
  const fo =
    near *
    defaultValue(pose.scene.focalLength, DEFAULT_FOCAL_LENGTH_MULTIPLIER);
  const eyeSeparation = defaultValue(pose.scene.eyeSeparation, DEFAULT_IPD);
  const frustumXOffset = (0.5 * eyeSeparation * near) / fo;

  console.log("Legacy VR Parameters:", {
    focalLength: fo / near,
    eyeSeparation,
    near,
    frustumXOffset,
  });

  if (
    !pose._paramsChanged &&
    fo === cameraParams._fo &&
    eyeSeparation === cameraParams._eyeSeparation
  ) {
    return;
  }

  const left = cameraParams.left;
  left.translationOp = Cartesian3.add;
  left.frustumXOffset = frustumXOffset;
  left.frustumAspectRatio =
    pose.viewports.left.width / pose.viewports.left.height;

  const right = cameraParams.right;
  right.translationOp = Cartesian3.subtract;
  right.frustumXOffset = -frustumXOffset;
  right.frustumAspectRatio =
    pose.viewports.right.width / pose.viewports.right.height;

  Cartesian3.multiplyByScalar(
    camera.right,
    eyeSeparation * 0.5,
    cameraParams._eyeTranslation
  );

  cameraParams._frustumNear = near;
  cameraParams._fo = fo;
  cameraParams._eyeSeparation = eyeSeparation;
}

function applyPoseParamsToCameraLegacy(pose, params, camera) {
  params.translationOp(
    pose._savedCamera.position,
    pose.cameraParams._eyeTranslation,
    camera.position
  );

  camera.frustum.xOffset = params.frustumXOffset;
  camera.frustum.aspectRatio = params.frustumAspectRatio;

  console.log(
    `Legacy Camera Parameters (${
      params.frustumXOffset > 0 ? "Left" : "Right"
    } Eye):`,
    {
      position: camera.position,
      frustumXOffset: params.frustumXOffset,
      aspectRatio: params.frustumAspectRatio,
      direction: camera.direction,
      up: camera.up,
      right: camera.right,
    }
  );

  return true;
}

function prepareViewportsXR(pose, xrPose) {
  for (const xrView of xrPose.views) {
    if (defined(xrView.requestViewPortScale)) {
      xrView.requestViewportScale(xrView.recommendedViewportScale);
    }

    const xrViewport = pose.xrLayer.getViewport(xrView);
    const eyeViewport = pose.viewports[xrView.eye];

    // Get the viewport dimensions from WebXR
    const displayWidth = pose.xrLayer.framebufferWidth;
    const halfWidth = displayWidth / 2;

    // Override the x position based on the eye
    eyeViewport.x = xrView.eye === "left" ? halfWidth : 0;
    eyeViewport.y = xrViewport.y;
    eyeViewport.width = xrViewport.width;
    eyeViewport.height = xrViewport.height;

    console.log(`XR Viewport for ${xrView.eye} eye:`, {
      x: eyeViewport.x,
      y: eyeViewport.y,
      width: eyeViewport.width,
      height: eyeViewport.height,
      totalWidth: displayWidth,
    });
  }
}

function arrayEquals(a, b) {
  //>>includeStart('debug', pragmas.debug);
  if (!defined(a) || !(a instanceof Float32Array) || a.length !== 16) {
    throw new DeveloperError(
      "a array must be a 16 element valid Float32Array."
    );
  }
  if (!defined(b) || !(b instanceof Float32Array) || b.length !== 16) {
    throw new DeveloperError(
      "b array must be a 16 element valid Float32Array."
    );
  }
  //>>includeEnd('debug');
  const differs = (value, idx) => value !== b[idx];
  return !a.some(differs);
}

function convertPerspectiveOffCenterFrustum(pocFrustum, result, isXR) {
  if (!defined(result)) {
    result = new PerspectiveFrustum();
  }

  const halfNearWidth = (pocFrustum.right - pocFrustum.left) / 2;
  const halfNearHeight = (pocFrustum.top - pocFrustum.bottom) / 2;

  // Calculate FOV considering XR distortion
  let fov = 2 * Math.atan(halfNearHeight / pocFrustum.near);
  if (isXR) {
    // Add slight increase to FOV for XR comfort and to account for lens distortion
    fov *= 1.1;
  }

  const aspectRatio = halfNearWidth / halfNearHeight;

  result.aspectRatio = aspectRatio;
  result.fov = fov;
  result.near = pocFrustum.near;
  result.far = pocFrustum.far;
  result.xOffset = (pocFrustum.right + pocFrustum.left) / 2;
  result.yOffset = (pocFrustum.top + pocFrustum.bottom) / 2;
  // flip the content of the frustum x axis
  result.xOffset = -result.xOffset;

  return result;
}

function prepareCameraParamsXR(camera, xrPose, xrView, params) {
  // Use the inverse matrices directly from WebXR
  const xrPoseTransform = Matrix4.fromArray(
    xrPose.transform.inverse.matrix,
    0,
    params.xrPoseTransform
  );

  const xrViewTransform = Matrix4.fromArray(
    xrView.transform.inverse.matrix,
    0,
    params.xrViewTransform
  );

  console.log(`Raw transforms for ${xrView.eye} eye:`, {
    viewInverse: xrView.transform.inverse.matrix,
    poseInverse: xrPose.transform.inverse.matrix,
  });

  // Combine view and pose transforms
  Matrix4.multiply(xrPoseTransform, xrViewTransform, params.deltaTransform);

  // Apply to camera view matrix
  Matrix4.multiply(
    camera.viewMatrix,
    params.deltaTransform,
    params.viewTransform
  );

  const projectionMatrix = xrView.projectionMatrix;
  if (
    defined(params._projectionMatrix) &&
    arrayEquals(params._projectionMatrix, projectionMatrix)
  ) {
    return;
  }

  params._projectionMatrix = Float32Array.from(projectionMatrix);

  PerspectiveOffCenterFrustum.fromProjectionMatrix(
    Matrix4.fromArray(projectionMatrix, 0, params.projectionTransform),
    params.pocFrustum
  );

  convertPerspectiveOffCenterFrustum(params.pocFrustum, params.frustum, true);

  console.log(`Transforms for ${xrView.eye} eye:`, {
    xrViewTransform: Matrix4.toArray(xrViewTransform),
    xrPoseTransform: Matrix4.toArray(xrPoseTransform),
  });

  // For right eye, we need to handle the transformation differently
  if (xrView.eye === "right") {
    // First apply view transform
    Matrix4.multiply(camera.viewMatrix, xrViewTransform, params.deltaTransform);

    // Then apply pose transform
    Matrix4.multiply(
      params.deltaTransform,
      xrPoseTransform,
      params.viewTransform
    );
  } else {
    // Left eye transformation remains the same
    Matrix4.multiply(xrViewTransform, xrPoseTransform, params.deltaTransform);

    Matrix4.multiply(
      params.deltaTransform,
      camera.viewMatrix,
      params.viewTransform
    );
  }

  // Log final transform
  console.log(
    `Final viewTransform for ${xrView.eye} eye:`,
    Matrix4.toArray(params.viewTransform)
  );

  if (
    defined(params._projectionMatrix) &&
    arrayEquals(params._projectionMatrix, projectionMatrix)
  ) {
    return;
  }

  params._projectionMatrix = Float32Array.from(projectionMatrix);

  const pocFrustum = PerspectiveOffCenterFrustum.fromProjectionMatrix(
    Matrix4.fromArray(projectionMatrix, 0, params.projectionTransform),
    params.pocFrustum
  );

  // Apply XR-specific FOV adjustments
  convertPerspectiveOffCenterFrustum(pocFrustum, params.frustum, true);
}

function preparePoseCameraParamsXR(pose, camera, xrPose) {
  pose.cameraParams._frustumNear = camera.frustum.near;
  pose.cameraParams._frustumFar = camera.frustum.far;

  console.log("Original camera state:", {
    position: camera.position,
    viewMatrix: Matrix4.toArray(camera.viewMatrix),
    modelMatrix: Matrix4.toArray(camera.transform),
  });

  for (const xrView of xrPose.views) {
    prepareCameraParamsXR(
      camera,
      xrPose,
      xrView,
      pose.cameraParams[xrView.eye]
    );
  }
}

function prepareXR(pose, camera) {
  const xr = pose.scene.webXRContext;
  if (!defined(xr)) {
    return false;
  }

  const xrFrame = xr.frame;
  if (!defined(xrFrame)) {
    return false;
  }

  const xrPose = xrFrame.getViewerPose(xr.refSpace);
  if (!defined(xrPose)) {
    return false;
  }

  const xrLayer = xrFrame.session.renderState.baseLayer;
  pose.xrLayer = xrLayer;

  if (!pose._initialized) {
    pose._initialized = true;
    for (const xrView of xrPose.views) {
      const eye = xrView.eye;
      pose.viewports[eye] = new BoundingRectangle();
      pose.cameraParams[eye] = {
        xrPoseTransform: new Matrix4(),
        xrViewTransform: new Matrix4(),
        deltaTransform: new Matrix4(),
        viewTransform: new Matrix4(),
        projectionTransform: new Matrix4(),
        pocFrustum: new PerspectiveOffCenterFrustum(),
        frustum: new PerspectiveFrustum(),
      };
    }
  }

  prepareViewportsXR(pose, xrPose);
  preparePoseCameraParamsXR(pose, camera, xrPose);
  return true;
}

function applyPoseParamsToCameraXR(pose, params, camera) {
  // Use lookAtTransform to properly update camera orientation
  camera.lookAtTransform(params.viewTransform);

  const frustum = camera.frustum;
  frustum.aspectRatio = params.frustum.aspectRatio;
  frustum.fov = params.frustum.fov;
  frustum.near = pose.cameraParams._frustumNear;
  frustum.far = pose.cameraParams._frustumFar;
  frustum.xOffset = params.frustum.xOffset;
  frustum.yOffset = params.frustum.yOffset;

  console.log("Camera state:", {
    viewMatrix: Matrix4.toArray(camera.viewMatrix),
    frustum: {
      fov: frustum.fov,
      near: frustum.near,
      xOffset: frustum.xOffset,
      yOffset: frustum.yOffset,
    },
  });

  return true;
}

function applyPoseToCamera(pose, eye, camera) {
  const params = pose.cameraParams[eye];
  if (!defined(params)) {
    console.warn(`Unrecognized eye ${eye}`);
    return false;
  }

  if (
    eye === "none" &&
    (defined(pose.viewports["left"]) || defined(pose.viewports["right"]))
  ) {
    return false;
  }

  if (pose.isWebXR) {
    return applyPoseParamsToCameraXR(pose, params, camera);
  }

  return applyPoseParamsToCameraLegacy(pose, params, camera);
}

class VRPose {
  constructor(scene) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(scene) || !(scene instanceof Scene)) {
      throw new DeveloperError("scene must be a valid Scene.");
    }
    //>>includeEnd('debug');

    this.isWebXR = scene.useWebXR && defined(scene.webXRContext);
    this.scene = scene;
    this.xrLayer = null;
    this.viewports = {};
    this.cameraParams = {};
    this._passStateViewport = null;
    this._paramsChanged = true;
    this._savedCamera = undefined;
    this._savedViewport = undefined;

    if (this.isWebXR) {
      this._initialized = false;
    } else {
      this.viewports.left = new BoundingRectangle();
      this.viewports.right = new BoundingRectangle();
      this.cameraParams.left = {};
      this.cameraParams.right = {};
      this.cameraParams._eyeTranslation = new Cartesian3();
    }
  }

  get passStateViewport() {
    return this._passStateViewport;
  }

  set passStateViewport(value) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(value) || !(value instanceof BoundingRectangle)) {
      throw new DeveloperError("value must be a valid BoundingRectangle.");
    }
    //>>includeEnd('debug');

    if (
      !this.isWebXR &&
      this._passStateViewport !== value &&
      !BoundingRectangle.equals(this._paramsChanged, value)
    ) {
      this._paramsChanged = true;
    }
    this._passStateViewport = value;
  }

  get camera() {
    return this._camera;
  }

  set camera(value) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(value) || !(value instanceof Camera)) {
      throw new DeveloperError("value must be a valid Camera.");
    }
    //>>includeEnd('debug');

    if (
      !this.isWebXR &&
      this.cameraParams._frustumNear !== value.frustum.near
    ) {
      this._paramsChanged = true;
    }
    this._camera = value;
  }

  prepare(camera, passStateViewport) {
    this.camera = camera;
    this.passStateViewport = passStateViewport;

    let validPose;

    if (this.isWebXR) {
      validPose = prepareXR(this, camera);
    } else {
      prepareViewportsLegacy(this);
      preparePoseCameraParamsLegacy(this, camera);
      validPose = true;
    }

    if (validPose) {
      this._paramsChanged = false;
    }
    return validPose;
  }

  apply(execute_cb) {
    const camera = this._camera;
    const savedCamera = Camera.clone(camera, this._savedCamera);
    const savedViewport = BoundingRectangle.clone(
      this._passStateViewport,
      this._savedViewport
    );

    for (const eye of Object.keys(this.viewports)) {
      if (applyPoseToCamera(this, eye, camera)) {
        BoundingRectangle.clone(this.viewports[eye], this._passStateViewport);
        execute_cb();
      }
    }

    BoundingRectangle.clone(savedViewport, this._passStateViewport);
    savedCamera.frustum = camera.frustum;
    Camera.clone(savedCamera, camera);
  }
}

export default VRPose;
