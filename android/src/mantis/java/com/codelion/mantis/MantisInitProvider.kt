package com.codelion.mantis

import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.net.Uri

/** Installs MantisAgent when the app process starts: content providers are created before Application.onCreate. */
class MantisInitProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    MantisAgent.install(context!!.applicationContext as Application)
    return true
  }

  override fun query(uri: Uri, p: Array<String>?, s: String?, a: Array<String>?, o: String?) = null
  override fun getType(uri: Uri) = null
  override fun insert(uri: Uri, values: ContentValues?) = null
  override fun delete(uri: Uri, s: String?, a: Array<String>?) = 0
  override fun update(uri: Uri, values: ContentValues?, s: String?, a: Array<String>?) = 0
}
