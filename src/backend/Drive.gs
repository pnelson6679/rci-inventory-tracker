/**
 * Drive.gs — Photo storage helpers.
 *
 * Layout: one sub-folder per vehicle ID under CONFIG.DRIVE_ROOT_FOLDER_ID.
 * BigQuery stores only the share URL, never the blob.
 */

/** Returns (creating if needed) the Drive folder for a given vehicle ID. */
function getVehicleFolder_(vehicleId) {
  var root = DriveApp.getFolderById(CONFIG.DRIVE_ROOT_FOLDER_ID);
  var existing = root.getFoldersByName(vehicleId);
  if (existing.hasNext()) return existing.next();
  return root.createFolder(vehicleId);
}

/**
 * Saves a base64 data-URL photo from the browser to the vehicle's Drive folder.
 * @return {string} The anyone-with-link view URL, suitable for storing in BigQuery.
 */
function Drive_savePhoto(vehicleId, dataUrl, filename) {
  // dataUrl looks like "data:image/jpeg;base64,/9j/4AAQ..."
  var parts = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!parts) throw new Error('Invalid data URL');

  var contentType = parts[1];
  var bytes = Utilities.base64Decode(parts[2]);
  var blob = Utilities.newBlob(bytes, contentType, filename || ('photo_' + Date.now()));

  var folder = getVehicleFolder_(vehicleId);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}
