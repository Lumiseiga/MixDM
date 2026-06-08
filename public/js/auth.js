/* ════════════════════════════════════════════════════
   MIXDM Frontend — auth.js
   Authentication & Login Logic
   ════════════════════════════════════════════════════ */

let currentUserProfile = null;

async function refreshCurrentUserProfile() {
  const res = await fetch('/api/auth/profile');
  const data = await res.json();
  if (!res.ok || !data.success || !data.user) {
    throw new Error(data.error || 'Failed to refresh profile');
  }
  currentUserProfile = data.user;
  localStorage.setItem(AUTH_USER_NAME_KEY, data.user.displayName || 'User');
  localStorage.setItem(AUTH_USER_ROLE_KEY, data.user.role || 'user');
  updateProfileUI(data.user);
  return data.user;
}

window.refreshCurrentUserProfile = refreshCurrentUserProfile;

function checkAuth() {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) {
    document.body.classList.add('logged-in');
    $('login-overlay').classList.add('hide');
    
    // Fetch profile details
    refreshCurrentUserProfile()
      .then(() => {
        if (typeof syncSettingsFromServer === 'function') syncSettingsFromServer().catch(() => {});
        if (typeof refreshQuotaStatus === 'function') refreshQuotaStatus();
        if (typeof connectSSE === 'function') connectSSE();
      })
      .catch(() => {
        // Fallback to localStorage if API fails temporarily
        const displayName = localStorage.getItem(AUTH_USER_NAME_KEY) || 'User';
        const role = localStorage.getItem(AUTH_USER_ROLE_KEY) || 'user';
        currentUserProfile = {
          displayName,
          role,
          avatarUrl: '',
          bio: '',
          subscription: 'free',
          subscriptionExpiresAt: null
        };
        updateProfileUI(currentUserProfile);
        if (typeof refreshQuotaStatus === 'function') refreshQuotaStatus();
        if (typeof connectSSE === 'function') connectSSE();
      });
  } else {
    document.body.classList.remove('logged-in');
    $('login-overlay').classList.remove('hide');
    $('btn-open-dev').style.display = 'none';
    if (typeof connectSSE === 'function') connectSSE();
  }
}

function updateProfileUI(user) {
  $('user-display-name').textContent = user.displayName || 'User';
  
  // Show/hide Developer button
  if (user.role === 'developer' || user.role === 'admin') {
    $('btn-open-dev').style.display = 'flex';
  } else {
    $('btn-open-dev').style.display = 'none';
  }

  // Update Avatar
  const avatarEl = $('user-display-avatar');
  if (avatarEl) {
    if (user.avatarUrl) {
      avatarEl.innerHTML = `<img src="${user.avatarUrl}" alt="Avatar" />`;
    } else {
      avatarEl.textContent = '👤';
    }
  }

  // Update Role Badge
  updateRoleBadge(user.role, user.subscription);

  if (typeof applyConnectionOptionsForProfile === 'function') {
    applyConnectionOptionsForProfile(user);
  }
}

function updateRoleBadge(role, subscription) {
  const roleEl = $('user-display-role');
  if (!roleEl) return;
  const plan = String(subscription || 'free').toLowerCase();

  roleEl.className = 'profile-role';
  roleEl.style.display = 'inline-block';

  if (role === 'admin') {
    roleEl.textContent = t('sub_admin', 'Admin');
    roleEl.classList.add('badge-admin');
  } else if (role === 'developer') {
    roleEl.textContent = 'Developer';
    roleEl.classList.add('badge-admin');
  } else if (plan === 'pro_yearly' || plan === 'pro-yearly') {
    roleEl.textContent = t('pricing_yearly_title', 'Pro Yearly');
    roleEl.classList.add('badge-pro');
  } else if (plan === 'pro' || plan === 'pro_monthly' || plan === 'pro-monthly') {
    roleEl.textContent = t('pricing_monthly_title', 'Pro Monthly');
    roleEl.classList.add('badge-pro');
  } else if (plan === 'lifetime') {
    roleEl.textContent = t('sub_lifetime', 'Lifetime');
    roleEl.classList.add('badge-lifetime');
  } else {
    // Normal user with free plan — hide badge
    roleEl.textContent = '';
    roleEl.style.display = 'none';
  }
}

// Toggle between Login and Sign-Up panels
$('link-to-signup').addEventListener('click', (e) => {
  e.preventDefault();
  $('login-form').style.display = 'none';
  $('signup-form').style.display = 'block';
  $('auth-title').textContent = 'Sign Up';
  $('auth-subtitle').textContent = 'Create your MIXDM account';
  $('login-error').classList.remove('show');
});

$('link-to-login').addEventListener('click', (e) => {
  e.preventDefault();
  $('signup-form').style.display = 'none';
  $('login-form').style.display = 'block';
  $('auth-title').textContent = 'MIXDM';
  $('auth-subtitle').textContent = 'Segmented Download Manager Prototype';
  $('login-error').classList.remove('show');
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const username = $('login-username').value.trim();
  const password = $('login-password').value.trim();
  const rememberMe = $('login-remember').checked;
  const btn = $('login-btn');
  const spinner = $('login-spinner');
  const errorEl = $('login-error');
  
  errorEl.classList.remove('show');
  
  if (!username || !password) {
    errorEl.textContent = 'กรุณากรอกข้อมูลให้ครบถ้วน (Please fill in all fields)';
    errorEl.classList.add('show');
    return;
  }
  
  btn.disabled = true;
  spinner.classList.add('show');
  
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, rememberMe })
    });
    
    const data = await res.json();
    
    if (res.ok && data.success) {
      localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      localStorage.setItem(AUTH_USER_NAME_KEY, data.user ? data.user.displayName : 'User');
      localStorage.setItem(AUTH_USER_ROLE_KEY, data.user ? data.user.role : 'user');
      currentUserProfile = data.user || {
        displayName: 'User',
        role: 'user',
        avatarUrl: '',
        bio: '',
        subscription: 'free',
        subscriptionExpiresAt: null
      };
      document.body.classList.add('logged-in');
      $('login-overlay').classList.add('hide');
      toast('เข้าสู่ระบบสำเร็จ (Login Successful)', 'success');
      
      updateProfileUI(currentUserProfile);
      if (typeof syncSettingsFromServer === 'function') syncSettingsFromServer().catch(() => {});
      if (typeof connectSSE === 'function') connectSSE();
      
      // Clear inputs
      $('login-username').value = '';
      $('login-password').value = '';
      $('login-remember').checked = false;
    } else {
      errorEl.textContent = data.error || 'การเข้าสู่ระบบล้มเหลว (Login Failed)';
      errorEl.classList.add('show');
    }
  } catch (err) {
    errorEl.textContent = 'ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้ (Connection Error)';
    errorEl.classList.add('show');
  } finally {
    btn.disabled = false;
    spinner.classList.remove('show');
  }
});

// Sign-Up form submission handling
$('signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const displayName = $('signup-displayname').value.trim();
  const email = $('signup-email').value.trim();
  const password = $('signup-password').value.trim();
  const confirmPassword = $('signup-confirm-password').value.trim();
  
  const btn = $('signup-btn');
  const spinner = $('signup-spinner');
  const errorEl = $('login-error');
  
  errorEl.classList.remove('show');
  
  if (!displayName || !email || !password || !confirmPassword) {
    errorEl.textContent = 'กรุณากรอกข้อมูลให้ครบถ้วน (Please fill in all fields)';
    errorEl.classList.add('show');
    return;
  }
  
  if (password !== confirmPassword) {
    errorEl.textContent = 'รหัสผ่านและการยืนยันรหัสผ่านไม่ตรงกัน (Passwords do not match)';
    errorEl.classList.add('show');
    return;
  }
  
  if (password.length < 12) {
    errorEl.textContent = 'รหัสผ่านต้องมีความยาวอย่างน้อย 12 ตัวอักษร (Password must be at least 12 characters)';
    errorEl.classList.add('show');
    return;
  }
  
  btn.disabled = true;
  spinner.classList.add('show');
  
  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName })
    });
    
    const data = await res.json();
    
    if (res.ok && data.success) {
      localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      localStorage.setItem(AUTH_USER_NAME_KEY, data.user ? data.user.displayName : displayName);
      localStorage.setItem(AUTH_USER_ROLE_KEY, data.user ? data.user.role : 'user');
      currentUserProfile = data.user || {
        displayName,
        role: 'user',
        avatarUrl: '',
        bio: '',
        subscription: 'free',
        subscriptionExpiresAt: null
      };
      document.body.classList.add('logged-in');
      $('login-overlay').classList.add('hide');
      toast('ลงทะเบียนและเข้าสู่ระบบสำเร็จ (Registration & Login Successful)', 'success');
      
      updateProfileUI(currentUserProfile);
      if (typeof syncSettingsFromServer === 'function') syncSettingsFromServer().catch(() => {});
      if (typeof connectSSE === 'function') connectSSE();
      
      // Clear inputs
      $('signup-displayname').value = '';
      $('signup-email').value = '';
      $('signup-password').value = '';
      $('signup-confirm-password').value = '';
      
      // Reset panel view to login for next time
      $('signup-form').style.display = 'none';
      $('login-form').style.display = 'block';
      $('auth-title').textContent = 'MIXDM';
      $('auth-subtitle').textContent = 'Segmented Download Manager Prototype';
    } else {
      errorEl.textContent = data.error || 'การลงทะเบียนล้มเหลว (Registration Failed)';
      errorEl.classList.add('show');
    }
  } catch (err) {
    errorEl.textContent = 'ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ได้ (Connection Error)';
    errorEl.classList.add('show');
  } finally {
    btn.disabled = false;
    spinner.classList.remove('show');
  }
});

async function logoutCurrentUser() {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
    } catch (err) {
      console.error('Failed to invalidate token on server:', err);
    }
  }
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_NAME_KEY);
  localStorage.removeItem(AUTH_USER_ROLE_KEY);
  currentUserProfile = null;
  checkAuth();
  toast('ออกจากระบบแล้ว (Logged Out)', 'info');
}

function closeProfileDropdown() {
  const profileSection = $('profile-section-btn');
  const dropdown = $('profile-dropdown');
  if (!profileSection || !dropdown) return;
  dropdown.classList.remove('show');
  profileSection.setAttribute('aria-expanded', 'false');
}

$('btn-logout')?.addEventListener('click', logoutCurrentUser);
$('profile-menu-logout')?.addEventListener('click', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeProfileDropdown();
  await logoutCurrentUser();
});

// Profile Modal Event Listeners
(function initProfileModal() {
  const profileSection = $('profile-section-btn');
  const profileDropdown = $('profile-dropdown');
  const profileSettings = $('profile-menu-settings');
  const overlay = $('profile-modal-overlay');
  const btnClose = $('profile-btn-close');
  const btnCancel = $('profile-btn-cancel');
  const btnSave = $('profile-btn-save');
  const spinner = $('profile-save-spinner');
  
  const nameInput = $('profile-name-input');
  const bioInput = $('profile-bio-input');
  const passInput = $('profile-pass-input');
  
  const avatarFile = $('profile-avatar-file-input');
  const avatarTrigger = $('btn-upload-avatar-trigger');
  const avatarWrap = document.querySelector('.profile-avatar-preview-wrap');
  const avatarPreview = $('profile-avatar-preview');
  const avatarPlaceholder = $('profile-avatar-placeholder');
  
  let currentAvatarBase64 = '';

  function getCachedProfile() {
    const displayName = localStorage.getItem(AUTH_USER_NAME_KEY) || $('user-display-name')?.textContent || 'User';
    const role = localStorage.getItem(AUTH_USER_ROLE_KEY) || 'user';
    return {
      displayName,
      role,
      avatarUrl: '',
      bio: '',
      subscription: 'free',
      subscriptionExpiresAt: null
    };
  }

  async function ensureProfile() {
    if (currentUserProfile) return currentUserProfile;

    try {
      const res = await fetch('/api/auth/profile');
      const data = await res.json();
      if (res.ok && data.success && data.user) {
        currentUserProfile = data.user;
        updateProfileUI(data.user);
        return currentUserProfile;
      }
    } catch (_) {}

    currentUserProfile = getCachedProfile();
    updateProfileUI(currentUserProfile);
    return currentUserProfile;
  }

  async function openModal() {
    await ensureProfile();
    
    nameInput.value = currentUserProfile.displayName || '';
    bioInput.value = currentUserProfile.bio || '';
    passInput.value = '';
    
    // Set avatar preview
    if (currentUserProfile.avatarUrl) {
      avatarPreview.src = currentUserProfile.avatarUrl;
      avatarPreview.style.display = 'block';
      avatarPlaceholder.style.display = 'none';
      currentAvatarBase64 = currentUserProfile.avatarUrl;
    } else {
      avatarPreview.src = '';
      avatarPreview.style.display = 'none';
      avatarPlaceholder.style.display = 'flex';
      currentAvatarBase64 = '';
    }
    
    overlay.classList.add('show');
  }

  function closeModal() {
    overlay.classList.remove('show');
  }

  // File Upload base64 trigger
  const handleAvatarChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    // Validation
    if (file.size > 2 * 1024 * 1024) {
      toast('รูปภาพต้องมีขนาดไม่เกิน 2MB (Image must be under 2MB)', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target.result;
      currentAvatarBase64 = base64;
      avatarPreview.src = base64;
      avatarPreview.style.display = 'block';
      avatarPlaceholder.style.display = 'none';
    };
    reader.readAsDataURL(file);
  };

  if (profileSection) {
    profileSection.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isOpen = profileDropdown?.classList.toggle('show');
      profileSection.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
  }
  if (profileSettings) {
    profileSettings.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeProfileDropdown();
      openModal();
    });
  }
  document.addEventListener('click', (e) => {
    if (!profileDropdown?.classList.contains('show')) return;
    if (e.target.closest('#profile-menu-wrapper')) return;
    closeProfileDropdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeProfileDropdown();
  });
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);
  if (overlay) {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  }

  if (avatarTrigger) {
    avatarTrigger.addEventListener('click', () => avatarFile.click());
  }
  if (avatarWrap) {
    avatarWrap.addEventListener('click', () => avatarFile.click());
  }
  if (avatarFile) {
    avatarFile.addEventListener('change', handleAvatarChange);
  }

  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      const displayName = nameInput.value.trim();
      const bio = bioInput.value.trim();
      const password = passInput.value;

      if (!displayName) {
        toast('กรุณากรอกชื่อที่แสดง (Display Name is required)', 'error');
        return;
      }

      if (password && password.length < 12) {
        toast('รหัสผ่านต้องมีความยาวอย่างน้อย 12 ตัวอักษร (Password must be at least 12 characters)', 'error');
        return;
      }

      btnSave.disabled = true;
      spinner.classList.add('show');

      try {
        const res = await fetch('/api/auth/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName,
            bio,
            avatarUrl: currentAvatarBase64,
            password: password || undefined
          })
        });

        const data = await res.json();
        if (res.ok && data.success) {
          toast(t('profile_success', 'Profile updated successfully!'), 'success');
          
          // Cache update
          currentUserProfile = data.user;
          localStorage.setItem(AUTH_USER_NAME_KEY, data.user.displayName);
          localStorage.setItem(AUTH_USER_ROLE_KEY, data.user.role);
          
          updateProfileUI(data.user);
          if (typeof refreshQuotaStatus === 'function') refreshQuotaStatus();
          closeModal();
        } else {
          toast(data.error || 'Failed to update profile', 'error');
        }
      } catch (err) {
        toast('Failed to connect to server', 'error');
      } finally {
        btnSave.disabled = false;
        spinner.classList.remove('show');
      }
    });
  }
})();
